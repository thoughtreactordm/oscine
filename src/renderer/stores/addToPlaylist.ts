import { defineStore } from 'pinia'
import { createAddToPlaylist } from '@renderer/panels/addToPlaylist'
import { usePlaylistsStore } from '@renderer/stores/playlists'

/**
 * The one "add to playlist" in the application.
 *
 * A store rather than a per-panel helper for two reasons, and only the second is
 * about sharing. The first is *lifetime*: the gesture is made from the sidebar,
 * which a tab change unmounts, and the work outlives the click — a new playlist
 * is named in a modal and filled afterwards. Anything owned by the pane the
 * right-click came from would be torn down halfway through.
 *
 * The second is that four surfaces offer it: the song list, the Artists pane,
 * the Albums pane and the playlist contents pane. They agree on the wording, on
 * "New playlist…" being last, and on what a failure says, because there is one
 * of each.
 *
 * Thin, like the rest of them. `createAddToPlaylist` holds the behaviour and
 * knows nothing of Pinia; this bolts the real playlists onto it.
 */
export const useAddToPlaylistStore = defineStore('addToPlaylist', () => {
  const playlists = usePlaylistsStore()

  return createAddToPlaylist({
    playlists: () => playlists.list,
    // No tab. The operator is browsing; see `playlists.create`.
    create: (name) => playlists.create(name, { openTab: false }),
    addTracks: (playlistId, trackIds) => playlists.addTracks(playlistId, trackIds)
  })
})
