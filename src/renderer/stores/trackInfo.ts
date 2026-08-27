import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Track } from '@shared/library'

/**
 * The one open Track Info dialog, as state rather than as a component tree.
 *
 * Mounted like `addToPlaylist`'s modal (see `NewPlaylistModal`): the gesture that
 * opens it is a right-click in a list or a card that a tab change unmounts, so the
 * dialog cannot live under the surface that offered it. The store outlives every
 * tab and `TrackInfoModal` — mounted once by the frame — watches it.
 *
 * A `Track` snapshot rather than an id: the row that was clicked already held the
 * display tags, and re-fetching them to draw them back would be a round trip for
 * data in hand. The format readout's own on-demand parse is the only thing the
 * modal fetches, keyed by `track.id`.
 */
export const useTrackInfoStore = defineStore('trackInfo', () => {
  /** The track whose info is showing, or `null` when the dialog is closed. */
  const track = ref<Track | null>(null)

  function show(next: Track): void {
    track.value = next
  }

  function close(): void {
    track.value = null
  }

  return { track, show, close }
})
