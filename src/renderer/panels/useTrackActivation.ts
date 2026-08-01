import { createTrackActivation } from '@renderer/panels/trackActivation'
import { queueRows } from '@renderer/playback/queueCommands'
import { useSettings } from '@renderer/settings'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import type { Track } from '@shared/library'

/**
 * `createTrackActivation`, bolted to the real verbs.
 *
 * A composable rather than a store because `playNow` differs per caller and a
 * Pinia store takes no arguments — the library list starts a track against the
 * browse query, the playlist pane against the playlist — and that is the one
 * verb this deliberately does not centralise. Everything it *does* close over is
 * a store, so the memoization that matters is still theirs.
 *
 * The behaviour is in `trackActivation.ts`, which knows nothing of Pinia and is
 * tested without it. This is the one place the real queue, the real playlists
 * and the real settings are attached.
 */
export function useTrackActivation(playNow: (track: Track, index: number) => void) {
  const queue = useQueueCommandsStore()
  const playlists = usePlaylistsStore()
  const addToPlaylist = useAddToPlaylistStore()

  return createTrackActivation({
    settings: useSettings(),
    playNow,
    playNext: (tracks) => queue.playNext(queueRows(tracks)),
    addToQueue: (tracks) => queue.addToQueue(queueRows(tracks)),
    viewedPlaylistId: () => playlists.viewedPlaylistId,
    // Through `addTo` rather than through the store's `addTracks`, so a
    // double-click reports what it did the same way the context menu does. It
    // is the same wording, the same failure text and the same toast.
    addToViewedPlaylist: (playlistId, trackIds) =>
      addToPlaylist.addTo(playlistId, { trackIds: () => Promise.resolve(trackIds), count: 1 })
  })
}
