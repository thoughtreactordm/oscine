import { normalizeLabel, splitGenres } from '@shared/genre'
import type { TagSource } from '@shared/tags'
import type { FieldDiff, GenreDiff, GenreValue, PendingWrite } from '@shared/tagWriteback'
import type { TrackTags } from '../metadata'

/**
 * The pending-write merge — **W16-1**, design authority D28.
 *
 * The pure half of the diff engine: given a track's fresh file tags and its
 * correction layers, it produces the `PendingWrite` W16-6 reviews and W16-2
 * flushes. Pure so it can be tested against synthesised inputs without a database
 * or a file on disk — the IO (resolving the path, reading the file, querying the
 * override and tag rows) is the orchestrator's in `differ.ts`, exactly the split
 * `metadata.ts` draws between `toTrackTags` and `readTrackTags`.
 *
 * ## Merge precedence (D28)
 *
 * Per field, the merged target is:
 *   1. `track_overrides` (D7, extended with `genre` and `year`) — a set override
 *      replaces the file's value outright, the way `title` already does.
 *   2. `track_tags` where `source IN ('user','suggested')` (W15) — the free-form
 *      user layer, which unions onto the genre frame.
 *   3. Canonicalization (W16-5) — normalises the resulting genre spellings.
 *
 * Scalar fields (title, artist, album, track, disc, year) stop at step 1: an
 * override wins, otherwise the file's own value stands and the field is unchanged.
 * Only genre reaches all three steps, because only genre is a set the layers
 * combine into rather than a single value one layer claims.
 *
 * ## The genre merge
 *
 * "Override replaces base, tags union on." The base genre set is the operator's
 * `genre` override split into a frame when set, and the file's own genre frame
 * otherwise — the same `splitGenres` the scanner derives `track_genres` with, so
 * a flush written here and re-scanned round-trips to the same set. The
 * user/suggested tags union on by key, contributing only genres the base does not
 * already carry. Canonicalization then rewrites spellings across the whole set.
 */

/**
 * A `track_overrides` row, or the all-null stand-in for a track that has none.
 *
 * Column names match the table (`artist_name`, `album_title`, `track_no`,
 * `disc_no`) so the orchestrator can hand a `SELECT *` row straight in. Every
 * column is nullable: a null is "no override for this field", which falls through
 * to the file's value.
 */
export interface TrackOverrideRow {
  readonly title: string | null
  readonly artist_name: string | null
  readonly album_title: string | null
  readonly track_no: number | null
  readonly disc_no: number | null
  readonly genre: string | null
  readonly year: number | null
}

/** No override row for the track: every field falls through to the file. */
export const NO_OVERRIDE: TrackOverrideRow = {
  title: null,
  artist_name: null,
  album_title: null,
  track_no: null,
  disc_no: null,
  genre: null,
  year: null
}

/** One user-layer assignment the genre frame unions in — label and provenance. */
export interface WritebackUserTag {
  readonly label: string
  readonly source: TagSource
}

/**
 * The genre canonicalizer seam — **W16-5**.
 *
 * Takes the merged genre set and returns it with spellings normalised and any
 * aliased keys folded together. W16-1 wires it as an injected parameter with an
 * identity default (`identityCanonicalizer`) so the diff is complete and testable
 * before W16-5's alias/rules table exists; W16-5 supplies the real implementation
 * without this file changing.
 */
export type GenreCanonicalizer = (genres: readonly GenreValue[]) => readonly GenreValue[]

/** The default: no canonicalization. Deduped by the merge already, returned as-is. */
export const identityCanonicalizer: GenreCanonicalizer = (genres) => genres

/** Everything the merge needs for one track. All of it read fresh at merge time. */
export interface PendingWriteInput {
  readonly trackId: number
  /** A fresh read of the file's tags — never the cached `tracks` row (R7). */
  readonly file: TrackTags
  /** The track's override row, or {@link NO_OVERRIDE}. */
  readonly override: TrackOverrideRow
  /** The track's `user`/`suggested` tag assignments. */
  readonly userTags: readonly WritebackUserTag[]
  /** Genre canonicalization (W16-5); defaults to identity. */
  readonly canonicalize?: GenreCanonicalizer
}

/** One scalar field: the override wins when set, otherwise the file's value stands. */
function scalarDiff<T extends string | number>(
  current: T | null,
  override: T | null
): FieldDiff<T> {
  const proposed = override ?? current
  return { current, proposed, changed: proposed !== current }
}

/** Split a genre string into the `{ key, label }` frame the diff carries. */
function frame(genre: string | null): GenreValue[] {
  return splitGenres(genre).map(({ key, genre: label }) => ({ key, label }))
}

/** Whether two genre frames differ in identity, spelling, or order. */
function genreFramesDiffer(a: readonly GenreValue[], b: readonly GenreValue[]): boolean {
  if (a.length !== b.length) return true
  return a.some((value, i) => value.key !== b[i].key || value.label !== b[i].label)
}

/**
 * The genre field: base (override or file), union the tags on by key, canonicalise.
 *
 * Base order is preserved and tags append in the order given, so the result is
 * deterministic. A tag whose key the base already carries is dropped — the base's
 * spelling wins — which is what makes the override "replace" and the tags "union
 * on" rather than fight over the same key.
 */
function genreDiff(input: PendingWriteInput): GenreDiff {
  const current = frame(input.file.genre)

  // Base: the override's genre frame when set, the file's own otherwise.
  const base = input.override.genre !== null ? frame(input.override.genre) : current

  const byKey = new Map<string, GenreValue>()
  for (const value of base) if (!byKey.has(value.key)) byKey.set(value.key, value)
  for (const tag of input.userTags) {
    const norm = normalizeLabel(tag.label)
    if (norm !== null && !byKey.has(norm.key)) byKey.set(norm.key, norm)
  }

  const canonicalize = input.canonicalize ?? identityCanonicalizer
  const proposed = canonicalize([...byKey.values()])

  return { current, proposed, changed: genreFramesDiffer(current, proposed) }
}

/**
 * Merges one track's correction layers into its pending write.
 *
 * The single entry point: every field's diff, plus the `hasChanges` summary the
 * review and flush branch on.
 */
export function computePendingWrite(input: PendingWriteInput): PendingWrite {
  const { file, override } = input

  const title = scalarDiff(file.title, override.title)
  const artist = scalarDiff(file.artist, override.artist_name)
  const album = scalarDiff(file.album, override.album_title)
  const trackNo = scalarDiff(file.trackNo, override.track_no)
  const discNo = scalarDiff(file.discNo, override.disc_no)
  const year = scalarDiff(file.year, override.year)
  const genres = genreDiff(input)

  const hasChanges =
    title.changed ||
    artist.changed ||
    album.changed ||
    trackNo.changed ||
    discNo.changed ||
    year.changed ||
    genres.changed

  return {
    trackId: input.trackId,
    title,
    artist,
    album,
    trackNo,
    discNo,
    year,
    genres,
    hasChanges
  }
}
