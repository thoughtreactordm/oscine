/**
 * A lean album card — **D25/D26**.
 *
 * The Quick Menu's "Recent Additions" list and the palette's Albums group both
 * want an album small enough to draw in a drawer row without the weight of a
 * facet projection. There is no `Album` type in `src/shared` today; this is it,
 * kept deliberately parallel to `DiscoverAlbumItem`'s fields rather than folded
 * into it — Discover carries a `grain` tag, a `trackCount` and a `why`, none of
 * which a recent-additions row has a use for.
 */
export interface AlbumCard {
  readonly albumId: number
  readonly title: string
  readonly artist: string | null
  readonly year: number | null
  readonly artworkHash: string | null
  /**
   * Arrival, as `MAX(indexed_at)` over the album's tracks (D25) — the newest
   * track's first-seen instant. `indexed_at`, never `mtime`: a re-tag or a
   * rescan must not reorder "recent".
   */
  readonly addedAt: number
}

/**
 * The ceiling on `library.recentlyAddedAlbums`' `limit`, enforced at the seam.
 *
 * A drawer list rather than a window — short, computed on open, and capped so a
 * caller cannot ask main to project every album it holds by arrival on a whim.
 */
export const MAX_RECENT_ALBUMS = 100
