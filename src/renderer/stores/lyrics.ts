import { defineStore } from 'pinia'
import { library, net } from '@renderer/ipc'
import { createLyricsLoader } from './lyricsLoader'

export type { LyricsLoader } from './lyricsLoader'
export { createLyricsLoader } from './lyricsLoader'

/**
 * One track's lyrics, held in a store rather than pane state for the same reason
 * the related store is one: the seed is the transport's, not the pane's. The
 * lyrics pane can be toggled off and back on, or the stage relaid, without
 * paying to re-resolve a document the machine already has. The pane asks for a
 * track and reads what comes back; the stale-response guard lives in
 * {@link createLyricsLoader}.
 */
export const useLyricsStore = defineStore('lyrics', () =>
  createLyricsLoader(library.getLyrics, () => {
    // Cancel the previous track's LRCLIB lookup at the socket (W17-4). Fire and
    // forget: a failed cancel is not worth surfacing, and the store's guard
    // already protects against a stale response.
    void net.cancelScope('lyrics').catch(() => {})
  })
)
