import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { FermataError, playlists } from '@renderer/ipc'
import { usePlaybackStore } from '@renderer/stores/playback'
import type { Playlist, PlaylistExportResult, PlaylistPathStyle } from '@shared/playlists'

/**
 * The playlists, and which one is being *looked at*.
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
 * Thin, like every store here: it holds tabs and CRUD. W5-3 hangs the tab strip
 * off it and W5-6 the contents pane.
 */
export const usePlaylistsStore = defineStore('playlists', () => {
  const list = ref<Playlist[]>([])
  const viewedPlaylistId = ref<number | null>(null)
  const notice = ref<string | null>(null)
  const loading = ref(false)

  const viewed = computed(
    () => list.value.find((playlist) => playlist.id === viewedPlaylistId.value) ?? null
  )

  function report(cause: unknown, fallback: string): void {
    notice.value = cause instanceof FermataError ? cause.message : fallback
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      list.value = await playlists.list()
      // A tab that no longer exists cannot stay selected — it may have been
      // deleted in another window, or by the `remove` below.
      if (!list.value.some((playlist) => playlist.id === viewedPlaylistId.value)) {
        viewedPlaylistId.value = list.value[0]?.id ?? null
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
   */
  function view(playlistId: number | null): void {
    viewedPlaylistId.value = playlistId
  }

  async function create(name: string, crossfadeMs?: number): Promise<Playlist | null> {
    try {
      const created = await playlists.create(name, crossfadeMs)
      await refresh()
      viewedPlaylistId.value = created.id
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
   * §5 rule 4: the crossfade a playing playlist is heard through has to follow
   * an edit made while it is playing, so the controller is told rather than left
   * with the value it captured at `playFromPlaylist`.
   */
  async function setCrossfade(playlistId: number, crossfadeMs: number): Promise<void> {
    try {
      await playlists.setCrossfade(playlistId, crossfadeMs)
      usePlaybackStore().playlistCrossfadeChanged(playlistId, crossfadeMs)
      await refresh()
    } catch (cause) {
      report(cause, 'That crossfade could not be saved.')
    }
  }

  /**
   * Deletes a playlist, stopping playback first if it was the playing one.
   *
   * Order matters: playback stops before the rows go, so the traversal is torn
   * down while its playlist still exists rather than resolving a position
   * against a table row that has just been cascaded away.
   */
  async function remove(playlistId: number): Promise<void> {
    try {
      usePlaybackStore().playlistDeleted(playlistId)
      await playlists.delete(playlistId)
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
    viewedPlaylistId,
    viewed,
    notice,
    loading,
    refresh,
    view,
    create,
    rename,
    setCrossfade,
    remove,
    reorder,
    exportM3u8
  }
})
