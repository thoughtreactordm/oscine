import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { FermataError, playlists } from '@renderer/ipc'
import { restoredTabSession, useViewSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import type { TabSession, TabStop } from '@shared/settings'
import type {
  Playlist,
  PlaylistExportResult,
  PlaylistInsertion,
  PlaylistPathStyle
} from '@shared/playlists'

/**
 * Which playlist is viewed, across restarts.
 *
 * §5 rule 5 is not in tension with this. The rule makes the up-next *queue*
 * transient — a queue is a statement about the next few minutes. Which
 * collection Curate is showing is a statement about the workspace, which is the
 * same kind of fact as the column layout and the transport modes, and it is
 * view-scoped for the same reason: ids are library-local, so a database copied
 * to another machine would restore a playlist that means something else.
 */
export const PLAYLIST_TABS_KEY = 'view.playlistTabs'

export interface CreatePlaylistOptions {
  /** View it after creating. Defaults to true — see `create`. */
  openTab?: boolean
}

/**
 * The playlists, and which one is being *looked at*.
 *
 * The §5 preamble makes `viewedPlaylistId` and `playingPlaylistId` separate
 * state, and this store owns exactly one of them. The other lives on the
 * playback controller and is never written from here. That separation is
 * structural rather than disciplinary: browsing the rail reaches nothing the
 * transport reads, so "switching collections must not disturb playback" is not
 * a rule anyone can forget to follow — there is no wire to pull.
 *
 * It runs the other way too. Deleting the playing playlist *does* have to stop
 * playback (§5 rule 4), and `remove` is where that crosses over, because the
 * deletion is an event this store performs and not a state the controller could
 * observe. One direction, one call site.
 *
 * `list` is every playlist and is what the rail draws. `openIds` is still
 * persisted so a restart can restore the viewed playlist; it is no longer a
 * visible tab set. `viewedStop` is the thing the pane actually switches on.
 *
 * Thin, like every store here: it holds the viewed stop and CRUD. W5-3 hung a
 * tab strip off it; the rail is the chooser now, and the strip is gone.
 */
export const usePlaylistsStore = defineStore('playlists', () => {
  const list = ref<Playlist[]>([])

  /**
   * Where Curate is: a playlist, a pinned fixture, or Discover.
   *
   * `viewedPlaylistId` used to *be* this ref and is now derived from it, which
   * is the whole of what W10-7 changed here. My Favorites is a stop the operator
   * can be looking at and is not a playlist (D18), so the two facts came apart:
   * everything asking "which playlist is on screen" — the contents pane's entry
   * store, "add to the viewed playlist" — wants the narrow one and correctly
   * gets `null` while Favorites is up, because there is no playlist there to
   * add to.
   */
  const viewedStop = ref<TabStop>(null)
  const notice = ref<string | null>(null)
  const loading = ref(false)

  const settings = useViewSettings()
  // Gated by `view.restoreSession`. The gate is on this read only; the watcher
  // below goes on recording whatever ends up open. See `restoredTabSession`.
  const restored = restoredTabSession(settings, PLAYLIST_TABS_KEY)

  /**
   * Last-viewed playlist ids, kept so a restart can restore `viewedStop` when
   * it names a playlist. The rail is the chooser now; this is no longer a
   * visible tab order.
   *
   * Still not `playlists.position` order — a restored viewed id is workspace,
   * not library.
   */
  const openIds = ref<number[]>(restored.openIds)
  viewedStop.value = restored.viewedId

  /** The viewed *playlist*, which is `null` on Discover and on My Favorites alike. */
  const viewedPlaylistId = computed<number | null>(() =>
    typeof viewedStop.value === 'number' ? viewedStop.value : null
  )

  const byId = (playlistId: number): Playlist | null =>
    list.value.find((playlist) => playlist.id === playlistId) ?? null

  /**
   * The last-viewed playlists, as rows. Filtered rather than mapped-with-holes:
   * an id whose playlist has not loaded yet is skipped, and `refresh` is what
   * finally prunes it.
   */
  const openTabs = computed<Playlist[]>(() =>
    openIds.value.map(byId).filter((playlist): playlist is Playlist => playlist !== null)
  )

  const isOpen = (playlistId: number): boolean => openIds.value.includes(playlistId)

  const viewed = computed(
    () => list.value.find((playlist) => playlist.id === viewedPlaylistId.value) ?? null
  )

  watch(
    [openIds, viewedStop],
    () => {
      settings.set<TabSession>(PLAYLIST_TABS_KEY, {
        openIds: openIds.value,
        viewedId: viewedStop.value
      })
    },
    { deep: true }
  )

  /**
   * The last edit to some playlist's *entries*, and a sequence so that two edits
   * to the same playlist are two events.
   *
   * Published rather than pushed. An add can be aimed at any tab from the
   * library list, so the place that knows an edit happened is whatever performed
   * it, and the place that knows whether it matters is the contents pane —
   * which reloads only when the edit was to the playlist it is showing. The
   * track list watches `roots.version` for exactly this reason and with exactly
   * this shape.
   */
  const entriesEdited = ref<{ playlistId: number; seq: number } | null>(null)

  function noteEntriesChanged(playlistId: number): void {
    entriesEdited.value = { playlistId, seq: (entriesEdited.value?.seq ?? 0) + 1 }
  }

  function report(cause: unknown, fallback: string): void {
    notice.value = cause instanceof FermataError ? cause.message : fallback
  }

  /**
   * Re-reads the list, and prunes the persisted viewed-id set against it.
   *
   * Guarded against a second concurrent read because the frame and the rail
   * each ask for one on mount — neither may assume the other is on screen, so
   * both call it, and a launch should still be one query.
   */
  async function refresh(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      list.value = await playlists.list()
      // A persisted id whose playlist no longer exists cannot stay — it may have
      // been deleted in another window, by the `remove` below, or a restored
      // session may name playlists from before a library was replaced.
      const known = new Set(list.value.map((playlist) => playlist.id))
      openIds.value = openIds.value.filter((playlistId) => known.has(playlistId))
      // Only a *playlist* stop can be pruned. My Favorites is pinned and is not
      // in `openIds`, so creating, reordering and deleting playlists around it
      // leaves it exactly where it was — which is what "permanent" has to mean.
      const viewed = viewedPlaylistId.value
      if (viewed !== null && !isOpen(viewed)) {
        viewedStop.value = null
      }
    } catch (cause) {
      report(cause, 'Could not read playlists.')
    } finally {
      loading.value = false
    }
  }

  /**
   * Selects the viewed stop. Writes one ref and touches nothing else — that is
   * the whole of the viewed half of the split, and it is meant to look this
   * small.
   *
   * Guarded to persisted playlist ids. The contents pane renders `viewed`, so a
   * viewed playlist the session cannot restore would be a pane the operator
   * cannot get back to after clicking away. Viewing one from the rail is
   * `openTab`'s job, which records it first.
   *
   * The fixtures pass the guard unconditionally, because they are pinned rather
   * than recorded: there is no id to have first, and nothing that could drop
   * the one they have.
   */
  function view(stop: TabStop): void {
    if (typeof stop !== 'number' || isOpen(stop)) viewedStop.value = stop
  }

  /**
   * Records a playlist as viewed. Idempotent, so the rail can call it on every
   * click without asking whether it was already the one on screen.
   */
  function openTab(playlistId: number): void {
    if (byId(playlistId) === null) return
    if (!isOpen(playlistId)) openIds.value = [...openIds.value, playlistId]
    viewedStop.value = playlistId
  }

  /**
   * Drops a playlist from the persisted set. The playlist itself is untouched
   * — `remove` below is the other verb.
   *
   * Dropping the viewed playlist lands on Discover: without a tab strip there
   * is no neighbour the eye is already on.
   */
  function close(playlistId: number): void {
    if (!isOpen(playlistId)) return
    openIds.value = openIds.value.filter((id) => id !== playlistId)
    if (viewedStop.value !== playlistId) return
    viewedStop.value = null
  }

  /**
   * Moves a tab within the open set.
   *
   * `toIndex` is an index into the list with the tab already spliced out, which
   * is the same contract `playlists.reorder` has and what `destinationIndex`
   * computes for both. Local only: nothing here reaches `playlists.position`,
   * because the rail owns that order.
   */
  function moveOpen(playlistId: number, toIndex: number): void {
    const from = openIds.value.indexOf(playlistId)
    if (from === -1) return
    const next = openIds.value.filter((id) => id !== playlistId)
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, playlistId)
    openIds.value = next
  }

  /**
   * Makes a playlist, and by default views it.
   *
   * `openTab` is a choice because there are now two ways to reach this and they
   * want opposite things. The rail's plus button *is* a request to work on a new
   * playlist, so it views it and starts an inline rename on it. "New
   * playlist…" from a context menu is not: the operator is browsing the library
   * with a right-click menu open, and yanking Curate's viewed collection
   * underneath them — moving the pane to something they have not looked at — is
   * exactly the interruption that gesture is supposed to avoid. The playlist
   * still appears in the rail either way; only the view is at stake.
   */
  async function create(
    name: string,
    options: CreatePlaylistOptions = {}
  ): Promise<Playlist | null> {
    try {
      const created = await playlists.create(name)
      await refresh()
      if (options.openTab ?? true) openTab(created.id)
      return created
    } catch (cause) {
      report(cause, 'That playlist could not be created.')
      return null
    }
  }

  async function rename(playlistId: number, name: string): Promise<void> {
    try {
      await playlists.rename(playlistId, name)
      await refresh()
    } catch (cause) {
      report(cause, 'That playlist could not be renamed.')
    }
  }

  /**
   * Deletes a playlist, stopping playback first if it was the playing one.
   *
   * Order matters: playback stops before the rows go, so the traversal is torn
   * down while its playlist still exists rather than resolving a position
   * against a table row that has just been cascaded away.
   *
   * Its persisted viewed-id goes too, and through `close` rather than through
   * `refresh`'s pruning, so a deleted playlist hands the view to Discover
   * instead of leaving `viewedStop` naming a row that just vanished.
   */
  async function remove(playlistId: number): Promise<void> {
    try {
      usePlaybackStore().playlistDeleted(playlistId)
      await playlists.delete(playlistId)
      close(playlistId)
      await refresh()
    } catch (cause) {
      report(cause, 'That playlist could not be deleted.')
    }
  }

  /**
   * D12's interop escape hatch. Returns what was written, or `null` if the
   * operator dismissed the save dialog or the write failed.
   *
   * The result carries the file's name and not its folder, because nothing
   * crossing the IPC boundary carries an absolute path — so a caller can say
   * *what* was saved but never *where*, which is fine, since the operator just
   * chose it.
   */
  async function exportM3u8(
    playlistId: number,
    pathStyle: PlaylistPathStyle
  ): Promise<PlaylistExportResult | null> {
    try {
      const result = await playlists.exportM3u8({ playlistId, pathStyle })
      // Entries whose files have gone missing are the one outcome an operator
      // has to be told about: the file saved, and it is quietly shorter than
      // the playlist they exported.
      if (result !== null && result.skippedCount > 0) {
        notice.value = `${result.fileName} left out ${result.skippedCount} ${
          result.skippedCount === 1 ? 'track whose file' : 'tracks whose files'
        } could not be found.`
      }
      return result
    } catch (cause) {
      report(cause, 'That playlist could not be exported.')
      return null
    }
  }

  /**
   * Adds tracks to any playlist, viewed or not.
   *
   * Here rather than on the entries store because the target is named: "add
   * these to Mix" is a gesture made from the *library*, about a playlist the
   * operator is not looking at, and routing it through the pane would mean the
   * pane could only ever add to itself.
   *
   * One call for the whole selection. `AddTracksToPlaylistRequest` takes a list
   * precisely so that dropping four thousand rows is one request and one
   * transaction rather than four thousand of each.
   */
  async function addTracks(
    playlistId: number,
    trackIds: readonly number[],
    insertion: PlaylistInsertion = { at: 'end' }
  ): Promise<boolean> {
    if (trackIds.length === 0) return false
    try {
      await playlists.addTracks({ playlistId, trackIds: [...trackIds], insertion })
      noteEntriesChanged(playlistId)
      await refresh()
      return true
    } catch (cause) {
      report(cause, 'Those tracks could not be added.')
      return false
    }
  }

  async function reorder(playlistId: number, toIndex: number): Promise<void> {
    try {
      // Returns the whole list rather than the moved playlist, so the rail
      // cannot end up holding a stale neighbour order. See `playlists.reorder`.
      list.value = await playlists.reorder(playlistId, toIndex)
    } catch (cause) {
      report(cause, 'Those playlists could not be reordered.')
    }
  }

  return {
    list,
    openIds,
    openTabs,
    isOpen,
    viewedStop,
    viewedPlaylistId,
    viewed,
    notice,
    loading,
    refresh,
    view,
    openTab,
    close,
    moveOpen,
    create,
    rename,
    remove,
    addTracks,
    entriesEdited,
    noteEntriesChanged,
    reorder,
    exportM3u8
  }
})
