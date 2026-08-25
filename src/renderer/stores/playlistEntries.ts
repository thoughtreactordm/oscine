import { defineStore } from 'pinia'
import { watch } from 'vue'
import { OscineError, playlists as ipc } from '@renderer/ipc'
import { createPlaylistEntryWindow } from '@renderer/panels/playlistEntryWindow'
import { useTrackGroupingStore } from '@renderer/stores/grouping'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import type { PlaylistInsertion } from '@shared/playlists'

/**
 * The viewed playlist's entries, and the four things that change them.
 *
 * Thin, like every store here: `createPlaylistEntryWindow` holds the paging and
 * the selection and knows nothing about Pinia or IPC, and this is the one place
 * the real `playlists.listEntries` is bolted on — the same split `trackList`
 * makes, and what lets the window be tested against a synthetic 10k-entry
 * playlist with no Electron process anywhere.
 *
 * It follows `viewedPlaylistId` and never writes it. Which playlist is *viewed*
 * is the tab bar's business (§5's preamble), and which is *playing* is the
 * controller's; this store reads one and cannot reach the other.
 *
 * Notices go to the playlists store rather than to a second channel of their
 * own. There is one alert for playlists and it renders in the strip directly
 * above this pane, which is where an operator is already looking when a drop
 * fails.
 */
export const usePlaylistEntriesStore = defineStore('playlistEntries', () => {
  const playlists = usePlaylistsStore()

  const grouping = useTrackGroupingStore()

  const panel = createPlaylistEntryWindow({
    fetchPage: (query) => ipc.listEntries(query),
    fetchIdPage: (query) => ipc.listEntryIds(query),
    fetchGroups: (query) => ipc.listEntryGroups(query)
  })

  watch(() => playlists.viewedPlaylistId, panel.setPlaylist, { immediate: true })

  /**
   * One preference, both lists.
   *
   * The operator asked for album headers in a playlist the same way they ask
   * for them in the song list, so it is the same switch — `GroupChooser` sits
   * in both headers and writes one stored value. A second preference would let
   * the two disagree about what "grouped" means and give the chooser two
   * meanings depending on which pane it was rendered in.
   *
   * Grouping a playlist necessarily re-sorts it, which grouping the song list
   * does not: the library is already album-major when the headers appear, and a
   * playlist is in whatever order it was authored. That is the trade the pane
   * makes explicit by disabling its reorder drag while this is on.
   */
  watch(
    () => grouping.enabled,
    (enabled) => panel.setOrder(enabled ? 'album' : 'position'),
    { immediate: true }
  )

  /**
   * Re-reads when *someone* edited the playlist on screen.
   *
   * Watched rather than called, because the edit is as likely to have come from
   * the library list — "add these four to Mix", aimed at a tab from outside this
   * store entirely — as from the pane itself. One subscription covers both, and
   * an edit to any other playlist correctly changes nothing here.
   */
  watch(
    () => playlists.entriesEdited,
    (edit) => {
      if (edit !== null && edit.playlistId === panel.playlistId.value) panel.reload()
    }
  )

  function report(cause: unknown, fallback: string): void {
    playlists.notice = cause instanceof OscineError ? cause.message : fallback
  }

  /**
   * Publishes the edit and re-reads the tab that owns it.
   *
   * The pane reloads through the subscription above rather than from here, so
   * that an edit made from the pane and one made from the library take the same
   * path. The tab is refreshed because it carries the entry count, and a strip
   * stating a number the pane disagrees with is worse than a redundant read of
   * a handful of rows.
   */
  async function settle(playlistId: number): Promise<void> {
    playlists.noteEntriesChanged(playlistId)
    await playlists.refresh()
  }

  /**
   * Adds into the viewed playlist at a chosen point.
   *
   * The request itself belongs to the playlists store, because adding to a tab
   * the operator is *not* looking at is a gesture the library makes; this is the
   * same verb aimed at the tab that is on screen, so it also has a pane to
   * re-read afterwards.
   */
  async function addTracks(
    trackIds: readonly number[],
    insertion: PlaylistInsertion
  ): Promise<void> {
    const playlistId = panel.playlistId.value
    if (playlistId === null) return
    await playlists.addTracks(playlistId, trackIds, insertion)
  }

  async function moveEntries(
    entryIds: readonly number[],
    insertion: PlaylistInsertion
  ): Promise<void> {
    const playlistId = panel.playlistId.value
    if (playlistId === null || entryIds.length === 0) return
    try {
      await ipc.moveEntries({ playlistId, entryIds: [...entryIds], insertion })
      await settle(playlistId)
    } catch (cause) {
      report(cause, 'Those entries could not be moved.')
    }
  }

  /**
   * Removes entries, including the one being heard.
   *
   * Nothing here consults playback, and that is deliberate: §5 stops playback
   * for exactly one event — deleting the playing *playlist*, rule 4, which is
   * `usePlaylistsStore().remove`. Removing the row that is currently audible is
   * not that event, so the track plays out and the traversal carries on against
   * the edited playlist, which is the live-position behaviour `playOrder.ts`
   * settled for every edit under a playing order.
   */
  async function removeEntries(entryIds: readonly number[]): Promise<void> {
    const playlistId = panel.playlistId.value
    if (playlistId === null || entryIds.length === 0) return
    try {
      await ipc.removeEntries({ playlistId, entryIds: [...entryIds] })
      // Before the reload: the rows are gone, and a selection still holding them
      // would report a count the pane cannot show.
      panel.forget(entryIds)
      await settle(playlistId)
    } catch (cause) {
      report(cause, 'Those entries could not be removed.')
    }
  }

  return { ...panel, addTracks, moveEntries, removeEntries }
})
