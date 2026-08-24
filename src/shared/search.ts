/**
 * Unified search — **D23**.
 *
 * One channel that answers across every local entity type at once, already
 * grouped and ranked in main. The command palette (D21) is its only caller: it
 * parses the leading prefix into a `SearchMode` and debounces this against the
 * entity groups, merging the synchronous Navigation / Actions / Settings groups
 * in the renderer.
 *
 * Local and authoritative, like `favorites.ts`. Nothing here reaches the
 * network — subscribed shows are matched against the local `podcasts` table,
 * and Apple's catalogue stays behind `podcasts.searchCatalog` in W9 Discover
 * (D23, D14). The palette never opens a socket.
 */

/**
 * The kinds a hit can be. `view`, `album`, `artist`, `playlist`, `track` and
 * `show` are the D21 result categories; `show` is a *subscribed* podcast, not a
 * catalogue result.
 *
 * `view` and `show` carry their own id space — a `view` hit's id keys the shell
 * tab, a `show` hit's id is a `podcasts` row — where the other four are library
 * entity ids.
 */
export type SearchEntityKind = 'view' | 'album' | 'artist' | 'playlist' | 'track' | 'show'

/**
 * The mode the leading prefix selects, parsed by the renderer before the query
 * crosses the wire. `blended` is the no-prefix discovery path; the rest are the
 * precision paths a power user reaches for with `>` (action), `@` (artist),
 * `#` (playlist) and `/` (setting).
 *
 * A mode is not the same axis as a `SearchEntityKind`: `action` and `setting`
 * resolve entirely in the renderer and never reach this channel, so main only
 * ever sees `blended`, `artist` or `playlist`.
 */
export type SearchMode = 'blended' | 'action' | 'artist' | 'playlist' | 'setting'

export interface SearchQuery {
  readonly text: string
  /** Parsed from the leading prefix by the renderer. */
  readonly mode: SearchMode
  /** The D21 per-group cap — the escape hatch against one group drowning another (RQ2). */
  readonly limitPerGroup: number
}

/**
 * One result row, uniform across kinds so the palette renders every group from
 * one component.
 *
 * `id` is the entity id — an `albumId`, `artistId`, `playlistId` or `trackId` —
 * except for `view` and `show`, which carry their own id space (see
 * `SearchEntityKind`). `score` is main's ranking, carried so a group orders
 * stably regardless of the order rows were assembled in.
 */
export interface SearchHit {
  readonly kind: SearchEntityKind
  readonly id: number
  readonly title: string
  /** A second line — "12 tracks", the artist name — or `null` when there is none. */
  readonly subtitle: string | null
  readonly artworkHash: string | null
  readonly score: number
}

export interface SearchGroup {
  readonly kind: SearchEntityKind
  /** Capped at the query's `limitPerGroup`. */
  readonly hits: SearchHit[]
}

export interface SearchResult {
  /** Empty groups are omitted; order is the D21 category order. */
  readonly groups: SearchGroup[]
}

/**
 * The ceiling on `SearchQuery.limitPerGroup`, enforced at the IPC seam.
 *
 * The palette asks for a handful of rows per group; this is the wall against a
 * caller turning one keystroke into a request to rank the whole library
 * (RQ2). The per-group cap is one of the two brakes on cross-type ranking — the
 * renderer's prefixes are the other.
 */
export const MAX_SEARCH_LIMIT_PER_GROUP = 25
