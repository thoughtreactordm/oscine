import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { FermataError, playlists } from '@renderer/ipc'
import { useViewSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import type { TabSession } from '@shared/settings'
import type {
  Playlist,
  PlaylistExportResult,
  PlaylistInsertion,
  PlaylistPathStyle
} from '@shared/playlists'

/**
 * Which playlists are open as tabs, across restarts.
 *
 * §5 rule 5 is not in tension with this. The rule makes the up-next *queue*
 * transient — a queue is a statement about the next few minutes. Which tabs are
 * open is a statement about the workspace, which is the same kind of fact as
 * the column layout and the transport modes, and it is view-scoped for the same
 * reason: ids are library-local, so a database copied to another machine would
 * restore tabs that mean something else.
 */
export const PLAYLIST_TABS_KEY = 'view.playlistTabs'

export interface CreatePlaylistOptions {
  /** Open it as a tab and view it. Defaults to true — see `create`. */
  openTab?: boolean
}

/**
 * The playlists, which of them are *open* as tabs, and which one is being
 * *looked at*.
 *
 * The §5 preamble makes `viewedPlaylistId` and `playingPlaylistId` separate
 * state, and this store owns exactly one of them. The other lives on the
 * playback controller and is never written from here. That separation is
 * structural rather than disciplinary: browsing a tab reaches nothing the
 * transport reads, so "switching tabs must not disturb playback" is not a rule
 * anyone can forget to follow — there is no wire to pull.
 *
 * It runs the other way too. Deleting the playing playlist *does* have to stop
 * playback (§5 rule 4), and `remove` is where that crosses over, because the
 * deletion is an event this store performs and not a state the controller could
 * observe. One direction, one call site.
 *
 * `list` is every playlist and is what the rail draws. `openIds` is the subset
 * with a tab, in tab order, and it is a *third* piece of state rather than a
 * property of a playlist: it is workspace, not library, so it lives in renderer
 * storage and never crosses IPC. Keeping the two apart is what makes closing a
 * tab mean closing a tab — before it existed, the strip drew `list` directly,
 * and the only way to take a tab off the screen was to delete the playlist under
 * it.
 *
 * Thin, like every store here: it holds tabs and CRUD. W5-3 hangs the tab strip
 * off it, W5-6 the contents pane, W5-9 the rail.
 */
export const usePlaylistsStore = defineStore('playlists', () => {
  const list = ref<Playlist[]>([])
  const viewedPlaylistId = ref<number | null>(null)
  const notice = ref<string | null>(null)
  const loading = ref(false)

  const settings = useViewSettings()
  const restored = settings.get<TabSession>(PLAYLIST_TABS_KEY)

  /**
   * Open tabs, in tab order — deliberately *not* `playlists.position` order.
   *
   * The rail owns the persisted order of the library's playlists; the strip owns
   * the order of the few that are open. Two orders that are allowed to disagree,
   * because the alternative — dropping a tab between two open tabs when unopened
   * playlists sit between them in the rail — has no single honest answer.
   */
  const openIds = ref<number[]>(restored.openIds)
  viewedPlaylistId.value = restored.viewedId

  const byId = (playlistId: number): Playlist | null =>
    list.value.find((playlist) => playlist.id === playlistId) ?? null

  /**
   * The tabs. Filtered rather than mapped-with-holes: an id whose playlist has
   * not loaded yet draws no tab, and `refresh` is what finally prunes it.
   */
  const openTabs = computed<Playlist[]>(() =>
    openIds.value.map(byId).filter((playlist): playlist is Playlist => playlist !== null)
  )

  const isOpen = (playlistId: number): boolean => openIds.value.includes(playlistId)

  const viewed = computed(
    () => list.value.find((playlist) => playlist.id === viewedPlaylistId.value) ?? null
  )

  watch(
    [openIds, viewedPlaylistId],
    () => {
      settings.set<TabSession>(PLAYLIST_TABS_KEY, {
        openIds: openIds.value,
        viewedId: viewedPlaylistId.value
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
   * Re-reads the list, and prunes the tab set against it.
   *
   * Guarded against a second concurrent read because the rail and the strip are
   * islands that each ask for one on mount — neither may assume the other is on
   * screen, so both call it, and Curate mounting both should still be one query.
   */
  async function refresh(): Promise<void> {
    if (loading.value) return
    loading.value = true
    try {
      list.value = await playlists.list()
      // A tab whose playlist no longer exists cannot stay open — it may have
      // been deleted in another window, by the `remove` below, or a restored
      // session may name playlists from before a library was replaced.
      const known = new Set(list.value.map((playlist) => playlist.id))
      openIds.value = openIds.value.filter((playlistId) => known.has(playlistId))
      if (viewedPlaylistId.value !== null && !isOpen(viewedPlaylistId.value)) {
        viewedPlaylistId.value = openIds.value[0] ?? null
      }
    } catch (cause) {
      report(cause, 'Could not read playlists.')
    } finally {
      loading.value = false
    }
  }

  /**
   * Selects the viewed tab. Writes one ref and touches nothing else — that is
   * the whole of the viewed half of the split, and it is meant to look this
   * small.
   *
   * Guarded to open tabs. The contents pane renders `viewed`, so a viewed
   * playlist with no tab would be a pane the operator cannot navigate back to
   * after clicking away. Opening one is `open`'s job, which says so in its name.
   */
  function view(playlistId: number | null): void {
    if (playlistId === null || isOpen(playlistId)) viewedPlaylistId.value = playlistId
  }

  /**
   * Opens a playlist as a tab and views it. Idempotent, so the rail can call it
   * on every click without asking whether a tab is already there.
   *
   * New tabs land at the end rather than beside the viewed one: the strip is a
   * sequence the operator arranges by dragging, and an insertion point that
   * depends on which tab happened to be focused makes that arrangement drift
   * under them.
   */
  function openTab(playlistId: number): void {
    if (byId(playlistId) === null) return
    if (!isOpen(playlistId)) openIds.value = [...openIds.value, playlistId]
    viewedPlaylistId.value = playlistId
  }

  /**
   * Takes a tab off the strip. The playlist is untouched — that is the whole
   * point of the rail existing, and `remove` below is the other verb.
   *
   * Closing the viewed tab views its neighbour, preferring the one that moved
   * into its place, which is where the eye already is.
   */
  function close(playlistId: number): void {
    const index = openIds.value.indexOf(playlistId)
    if (index === -1) return
    openIds.value = openIds.value.filter((id) => id !== playlistId)
    if (viewedPlaylistId.value !== playlistId) return
    viewedPlaylistId.value = openIds.value[Math.min(index, openIds.value.length - 1)] ?? null
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
   * Makes a playlist, and by default opens it.
   *
   * `openTab` is a choice because there are now two ways to reach this and they
   * want opposite things. The rail's plus button *is* a request to work on a new
   * playlist, so it opens a tab and starts an inline rename on it. "New
   * playlist…" from a context menu is not: the operator is browsing the library
   * with a right-click menu open, and rearranging Curate's tab strip underneath
   * them — moving the viewed tab to something they have not looked at — is
   * exactly the interruption that gesture is supposed to avoid. The playlist
   * still appears in the rail either way; only the tab is at stake.
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
   * Its tab goes too, and through `close` rather than through `refresh`'s
   * pruning, so a deleted playlist hands the view to its neighbour like any
   * other close instead of jumping to the first open tab.
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
   * these to Mix" is a gesture made from the *library*, about a tab the operator
   * is not looking at, and routing it through the pane would mean the pane could
   * only ever add to itself.
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
      // Returns the whole list rather than the moved playlist, so the tab bar
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
