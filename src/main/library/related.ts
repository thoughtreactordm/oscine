import type { Track } from '@shared/library'
import {
  RELATED_SECTION_LIMIT,
  type RelatedAlbum,
  type RelatedAlbumSection,
  type RelatedResult,
  type RelatedSection
} from '@shared/related'

/**
 * W7-5's seam.
 *
 * The card asks for the neighbourhood query to be replaceable "without touching
 * the pane", and this is where that promise is kept. Three things are separated
 * on purpose:
 *
 *   - `RelatedQueries` is data access. `LibraryStore.relatedQueries()` is the
 *     only implementation that talks to SQLite; tests supply their own.
 *   - `NeighbourhoodStrategy` is the weak half — genre, year, folder — behind a
 *     single function type. `tagNeighbourhood` is the v1 implementation, and
 *     when M3's FTS5 work lands its replacement is a second function passed to
 *     `buildRelated`. Nothing above this file changes: not the IPC contract,
 *     not the store, not the pane.
 *   - `buildRelated` is the composition, and it is the part that stays.
 *
 * The catalog half is deliberately *not* behind the strategy. "Other albums by
 * this artist" is a fact about foreign keys; there is no better version of it
 * for a future card to supply, and putting it behind a seam would suggest there
 * were.
 */

export interface RelatedSeed {
  trackId: number
  rootId: number
  relPath: string
  albumId: number | null
  albumTitle: string | null
  /** The track's own performer — what "appears on" is judged by. */
  artistId: number | null
  artistName: string | null
  /** The album's credited artist — what the discography is judged by. */
  albumArtistId: number | null
  albumArtistName: string | null
  genre: string | null
  year: number | null
}

export interface RelatedQueries {
  seed(trackId: number): RelatedSeed | null
  albumTracks(input: { albumId: number; trackId: number; limit: number }): Track[]
  artistAlbums(input: { artistId: number; albumId: number | null; limit: number }): RelatedAlbum[]
  compilations(input: { artistId: number; albumId: number | null; limit: number }): RelatedAlbum[]
  sameGenre(input: { genre: string; albumId: number | null; limit: number }): RelatedAlbum[]
  sameYear(input: { year: number; albumId: number | null; limit: number }): RelatedAlbum[]
  sameFolder(input: {
    rootId: number
    prefix: string
    prefixEnd: string
    albumId: number | null
    limit: number
  }): RelatedAlbum[]
}

/**
 * The replaceable half. Returns sections in the order they should be read.
 *
 * `limit` is the number of rows a section may *show*; implementations should
 * ask their queries for one more than that and let `buildRelated` trim — see
 * `takeAlbums`.
 */
export type NeighbourhoodStrategy = (
  queries: RelatedQueries,
  seed: RelatedSeed,
  limit: number
) => RelatedAlbumSection[]

/**
 * The subtree a folder neighbourhood covers, or `null` when there is not one.
 *
 * The seed's *parent* directory rather than its own, and that is the whole
 * design of this strand. A track's own directory is, in every library anyone
 * organises, the album folder — so a neighbourhood scoped to it would return
 * the album the catalog half already lists in full, and the strand would be a
 * heading over rows the operator just read. The parent is where the sibling
 * records live: `Artist/Album/track.flac` neighbours the artist's other albums
 * on disk, and `Genre/Artist/Album/track.flac` neighbours the artist's peers.
 *
 * `null` when the path has fewer than two directory components, because then
 * there is no parent inside the root and the "neighbourhood" would be the
 * entire library — which is not a relation, it is a list.
 *
 * `prefixEnd` is the prefix with its last character stepped one code unit up,
 * which turns a prefix match into a half-open range the `UNIQUE(root_id,
 * rel_path)` index can serve. Safe on these values specifically: paths are
 * stored POSIX-normalised per the standing invariant, so the prefix always ends
 * in `/` (U+002F) and the successor is `0` (U+0030) — both ASCII, both below
 * any surrogate, so no pair is split and the comparison stays a byte ordering.
 */
export function folderNeighbourhood(relPath: string): { prefix: string; prefixEnd: string } | null {
  const lastSlash = relPath.lastIndexOf('/')
  if (lastSlash < 0) return null
  const parentSlash = relPath.lastIndexOf('/', lastSlash - 1)
  if (parentSlash < 0) return null

  const prefix = relPath.slice(0, parentSlash + 1)
  const head = prefix.slice(0, -1)
  const tail = prefix.charCodeAt(prefix.length - 1)
  return { prefix, prefixEnd: `${head}${String.fromCharCode(tail + 1)}` }
}

/** The last path component of a directory prefix, for the section's label. */
function folderLabel(prefix: string): string {
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  const lastSlash = trimmed.lastIndexOf('/')
  return lastSlash < 0 ? trimmed : trimmed.slice(lastSlash + 1)
}

/**
 * Trims an over-fetched page and reports whether it was over-fetched.
 *
 * Every strand asks for `limit + 1`, because `LIMIT n` returning exactly `n`
 * rows cannot distinguish "that is all there is" from "there is more". The
 * extra row is never shown; it exists so the pane can say "50 of more" honestly
 * instead of implying a round number is the whole truth.
 */
function takeAlbums(
  rows: readonly RelatedAlbum[],
  limit: number
): { albums: RelatedAlbum[]; truncated: boolean } {
  return { albums: rows.slice(0, limit), truncated: rows.length > limit }
}

/**
 * The v1 neighbourhood: three tag coincidences, weakest last.
 *
 * Genre first because a shared genre is at least a claim somebody typed, year
 * second, folder last — folder is the one most likely to be an artefact of how
 * the files were downloaded rather than of what they are.
 *
 * Each strand is skipped entirely when its dimension is absent on the seed. In
 * particular a track whose file carried no genre tag — or one indexed before
 * migration 10 and not yet rescanned — produces no genre section rather than an
 * empty one, which is why the migration needed no special case in the pane.
 */
export const tagNeighbourhood: NeighbourhoodStrategy = (queries, seed, limit) => {
  const sections: RelatedAlbumSection[] = []
  const fetch = limit + 1

  if (seed.genre !== null) {
    const { albums, truncated } = takeAlbums(
      queries.sameGenre({ genre: seed.genre, albumId: seed.albumId, limit: fetch }),
      limit
    )
    if (albums.length > 0) {
      sections.push({ kind: 'albums', strand: 'genre', detail: seed.genre, truncated, albums })
    }
  }

  if (seed.year !== null) {
    const { albums, truncated } = takeAlbums(
      queries.sameYear({ year: seed.year, albumId: seed.albumId, limit: fetch }),
      limit
    )
    if (albums.length > 0) {
      sections.push({
        kind: 'albums',
        strand: 'year',
        detail: String(seed.year),
        truncated,
        albums
      })
    }
  }

  const folder = folderNeighbourhood(seed.relPath)
  if (folder !== null) {
    const { albums, truncated } = takeAlbums(
      queries.sameFolder({
        rootId: seed.rootId,
        prefix: folder.prefix,
        prefixEnd: folder.prefixEnd,
        albumId: seed.albumId,
        limit: fetch
      }),
      limit
    )
    if (albums.length > 0) {
      sections.push({
        kind: 'albums',
        strand: 'folder',
        detail: folderLabel(folder.prefix),
        truncated,
        albums
      })
    }
  }

  return sections
}

export interface BuildRelatedOptions {
  limit?: number
  neighbourhood?: NeighbourhoodStrategy
}

/**
 * Every strand for one seed track, catalog half first.
 *
 * Returns `null` only when the seed track is not in the library — a track that
 * exists but relates to nothing returns a result with no sections, which is a
 * different answer and the one the pane's empty state is written against.
 *
 * The discography is keyed on the album artist and the compilations on the
 * track artist, falling back to each other when either is missing: a loose
 * track with no album has no album artist, and a compilation's own tracks
 * frequently carry only a performer. Without the fallback both strands would
 * vanish for exactly the tracks that most need them.
 */
export function buildRelated(
  queries: RelatedQueries,
  trackId: number,
  options: BuildRelatedOptions = {}
): RelatedResult | null {
  const limit = options.limit ?? RELATED_SECTION_LIMIT
  const neighbourhood = options.neighbourhood ?? tagNeighbourhood
  const fetch = limit + 1

  const seed = queries.seed(trackId)
  if (seed === null) return null

  const sections: RelatedSection[] = []

  if (seed.albumId !== null) {
    const rows = queries.albumTracks({ albumId: seed.albumId, trackId, limit: fetch })
    if (rows.length > 0) {
      sections.push({
        kind: 'tracks',
        strand: 'album-tracks',
        detail: seed.albumTitle,
        truncated: rows.length > limit,
        tracks: rows.slice(0, limit)
      })
    }
  }

  const discographyArtist = seed.albumArtistId ?? seed.artistId
  if (discographyArtist !== null) {
    const { albums, truncated } = takeAlbums(
      queries.artistAlbums({
        artistId: discographyArtist,
        albumId: seed.albumId,
        limit: fetch
      }),
      limit
    )
    if (albums.length > 0) {
      sections.push({
        kind: 'albums',
        strand: 'artist-albums',
        detail: seed.albumArtistName ?? seed.artistName,
        truncated,
        albums
      })
    }
  }

  const appearingArtist = seed.artistId ?? seed.albumArtistId
  if (appearingArtist !== null) {
    const { albums, truncated } = takeAlbums(
      queries.compilations({ artistId: appearingArtist, albumId: seed.albumId, limit: fetch }),
      limit
    )
    if (albums.length > 0) {
      sections.push({
        kind: 'albums',
        strand: 'compilations',
        detail: seed.artistName ?? seed.albumArtistName,
        truncated,
        albums
      })
    }
  }

  sections.push(...neighbourhood(queries, seed, limit))

  return { seedTrackId: trackId, sections }
}
