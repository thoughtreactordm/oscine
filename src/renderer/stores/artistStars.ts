import { defineStore } from 'pinia'
import { favorites as ipc } from '@renderer/ipc'
import { createEntityFavorites } from '@renderer/stores/entityFavorites'

/**
 * The artist star — the **real** favorite-artist store, **D24**, product rule 6.
 *
 * Distinct from `artistFavorites.ts`, which is "favorite tracks by the playing
 * artist" and favorites no artist at all — that store holds a deck pane, this
 * one holds a boolean about an `artists` row. The file is named for the glyph
 * (`artistStars`) so the two never get imported for each other; the store id
 * (`artistFavoriteStars`) is likewise distinct from that store's
 * `artistFavorites`.
 *
 * `createEntityFavorites` over the artist pair of W13-3 channels, keyed on the
 * local `artists.id` — the same id the identity header already resolves.
 */
export const useArtistFavorites = defineStore('artistFavoriteStars', () =>
  createEntityFavorites({
    toggle: (id) => ipc.toggleArtist(id),
    state: (ids) => ipc.artistState(ids)
  })
)
