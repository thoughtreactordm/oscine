import type { Track } from './library'

/**
 * Relatedness computed from the local index, and from nothing else.
 *
 * W7-5 is explicit that this is a *catalog* notion of related: what the library
 * already knows because it read the tags. It is deliberately not the
 * MusicBrainz artist-relations pane, which is a claim about the world rather
 * than about these files and lives in M7 behind a network layer that phase 1
 * does not have. Keeping the two apart is what lets this one be synchronous,
 * offline and exact.
 *
 * The strands split into two halves that differ in how much they should be
 * trusted, and the pane says so. The catalog half is derived from identity —
 * this album, this artist — and is as right as the tags are. The neighbourhood
 * half is derived from coincidence: a shared genre string, a shared year, a
 * shared parent folder. Any of those can be an accident, which is why they are
 * a separate group under a weaker heading rather than mixed into one ranked
 * list that would imply they are the same kind of fact.
 */

export type RelatedStrand =
  'album-tracks' | 'artist-albums' | 'compilations' | 'genre' | 'year' | 'folder'

/** Derived from identity. As reliable as the tags are. */
export const CATALOG_STRANDS = ['album-tracks', 'artist-albums', 'compilations'] as const

/** Derived from coincidence. See the note on `RelatedResult`. */
export const NEIGHBOURHOOD_STRANDS = ['genre', 'year', 'folder'] as const

/**
 * An album as the related pane needs it.
 *
 * Not `AlbumFacet`: that shape belongs to the browser's facet dimension, which
 * carries selection state and a filtered count that means "under the current
 * predicate". Nothing here is under a predicate — the counts are the album's
 * own — and a pane that reused the facet type would inherit a `total` whose
 * meaning changes when someone types in the search box.
 *
 * No artwork. The deck panes are text rows at a uniform height, which is what
 * keeps `visibleRange` arithmetic rather than a measurement pass; adding a
 * thumbnail column here would be a design change to the deck, not to this card.
 */
export interface RelatedAlbum {
  albumId: number
  title: string
  /** The album artist. `null` for an album whose tracks never named one. */
  artist: string | null
  year: number | null
  /** Tracks on the album, indexed. Not filtered by anything. */
  trackCount: number
}

export interface RelatedTrackSection {
  kind: 'tracks'
  strand: 'album-tracks'
  /** The album's title, so the pane can name what it is listing. */
  detail: string | null
  /** More rows existed than the cap allowed. The pane says so rather than lying. */
  truncated: boolean
  tracks: Track[]
}

export interface RelatedAlbumSection {
  kind: 'albums'
  strand: Exclude<RelatedStrand, 'album-tracks'>
  /** The value the strand matched on — the genre, the year, the folder name. */
  detail: string | null
  truncated: boolean
  albums: RelatedAlbum[]
}

export type RelatedSection = RelatedTrackSection | RelatedAlbumSection

export interface RelatedQuery {
  trackId: number
}

/**
 * Empty sections are dropped before this crosses IPC.
 *
 * A section with nothing in it is not information the pane can use — it would
 * render a heading over a blank space, which reads as a failed query rather
 * than as an absence. The pane's own empty state handles "nothing related at
 * all", which is a different and much more informative thing to say.
 */
export interface RelatedResult {
  seedTrackId: number
  sections: RelatedSection[]
}

/**
 * Rows per section, and the reason the pane stays inside the frame budget.
 *
 * A genre in a large library is not a small set — "Rock" over a 100k-track
 * synthetic library matches tens of thousands of rows — so every strand is
 * asked for a bounded page rather than for everything it could match. Fifty is
 * well past what anyone reads in a deck pane and small enough that the whole
 * result is a few kilobytes of structured clone.
 *
 * It bounds the query as well as the payload: the neighbourhood strands group
 * by album inside a subquery carrying this limit, so SQLite stops walking the
 * index once it has enough albums instead of aggregating the entire genre.
 */
export const RELATED_SECTION_LIMIT = 50
