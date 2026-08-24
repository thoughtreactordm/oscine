import type { SearchMode } from '@shared/search'

/**
 * The leading prefix, parsed into a mode — the renderer half of D21.
 *
 * The palette is one input over many kinds of thing, and the prefix is how a
 * power user says which kind they mean before they have typed the query. It is a
 * renderer concern by construction: main is handed a `SearchMode` already, and
 * two of the modes never reach main at all (see `queryReachesMain`).
 *
 * DOM-free and store-free on purpose — this is the seam the palette's tests hold
 * without mounting a component. `paletteSearch` and `CommandPalette.vue` are the
 * only callers.
 */

const PREFIX_MODES: Readonly<Record<string, SearchMode>> = {
  '>': 'action',
  '@': 'artist',
  '#': 'playlist',
  '/': 'setting'
}

export interface ParsedPaletteQuery {
  readonly mode: SearchMode
  /** The query with the prefix removed and the ends trimmed. */
  readonly text: string
}

/**
 * Splits a raw palette input into its mode and its text.
 *
 * Only the very first character is a prefix; `>` mid-word is ordinary text, so a
 * title with a `#` in it still searches. No prefix is `blended`, the discovery
 * path.
 */
export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const prefix = raw.charAt(0)
  const mode = PREFIX_MODES[prefix]
  if (mode) {
    return { mode, text: raw.slice(1).trim() }
  }
  return { mode: 'blended', text: raw.trim() }
}

/**
 * Whether a mode's query is answered by main's `search.query`.
 *
 * `action` and `setting` resolve entirely in the renderer — their groups are the
 * command and settings registries, not the library — so they never cross the
 * wire (D21, and `SearchMode`'s own contract in `src/shared/search.ts`). Only
 * `blended`, `artist` and `playlist` do.
 */
export function queryReachesMain(mode: SearchMode): boolean {
  return mode === 'blended' || mode === 'artist' || mode === 'playlist'
}
