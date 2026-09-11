import { defineStore } from 'pinia'
import { library } from '@renderer/ipc'
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
export const useLyricsStore = defineStore('lyrics', () => createLyricsLoader(library.getLyrics))
