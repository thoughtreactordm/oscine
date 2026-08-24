import { defineStore } from 'pinia'
import { favorites as ipc } from '@renderer/ipc'
import { createEntityFavorites } from '@renderer/stores/entityFavorites'

/**
 * The playlist star — **D24**, product rule 6.
 *
 * `createEntityFavorites` over the playlist pair of W13-3 channels. The star
 * denotes a favorited *playlist*; the heart stays tracks-only, and the two are
 * never the same glyph. Toggling and hydration follow the shared store; only the
 * two channels are playlist-specific.
 */
export const usePlaylistFavorites = defineStore('playlistFavorites', () =>
  createEntityFavorites({
    toggle: (id) => ipc.togglePlaylist(id),
    state: (ids) => ipc.playlistState(ids)
  })
)
