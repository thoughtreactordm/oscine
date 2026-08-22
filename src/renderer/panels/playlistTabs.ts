import { FAVORITES_TAB, type TabStop } from '@shared/settings'

/**
 * Discover, as a place the rail can be — and what a null `viewedStop` means.
 *
 * Representing it as `null` rather than as a synthetic playlist row is why
 * every verb that could damage a fixture — rename, delete, reorder — takes a
 * `number`. Discover cannot reach any of them.
 */
export const DISCOVER_TAB = null

/**
 * The pinned Favorites collection, beside Discover at the top of the rail.
 *
 * Defined with `TabSession` rather than here because it is a value the session
 * restores to, and re-exported from here because this is the module that says
 * what a stop is. Same trick as Discover: it is not a `playlists` row, so it
 * cannot be renamed, reordered or deleted.
 */
export { FAVORITES_TAB }

/** A place Curate can be: a playlist, or one of the two fixtures. */
export type { TabStop }
