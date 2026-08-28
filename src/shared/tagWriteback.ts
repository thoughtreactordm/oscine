/**
 * The pending-write diff model — **W16-1**, design authority D28.
 *
 * D7 keeps every tag correction in the database and never on disk: overrides in
 * `track_overrides`, the free-form layer in `track_tags`. D28 adds the one
 * deliberate exception — an operator-initiated, staged, atomic flush of those
 * layers back into the actual file tags. The unit that flush stages, reviews and
 * reports on is the **pending write**: for a single track, the field-level delta
 * between what its file currently holds and what the merged correction layers say
 * it should hold.
 *
 * ## Why the shape lives in `src/shared`
 *
 * A pending write is minted in the main process (the merge reads the database and
 * the file), reviewed in the renderer (W16-6 draws the diff), and flushed back in
 * the main process (W16-2 writes the bytes). Three consumers across the process
 * boundary means one contract, and `src/shared` is the only place that boundary
 * is allowed to be crossed — the same reason W15's tag wire shapes live in
 * `tags.ts`. Nothing here reaches for the database or the filesystem; those types
 * are the merge's own, in `src/main/library/writeback`.
 *
 * ## What a diff records, and why `current` is a fresh read
 *
 * Each field carries both sides: `current` is what the file holds *right now* —
 * read live at merge time, never the cached `tracks` row — and `proposed` is the
 * merged target. Keeping both is what lets the review surface show the operator a
 * before/after rather than a bare list of new values, and what lets the flush
 * skip a file whose bytes already match. Reading `current` from the file rather
 * than the row is the R7 guarantee: a file another tool edited out-of-band since
 * the last scan surfaces as a diff *against the file*, so the flush reconciles it
 * instead of clobbering it with a stale cached value.
 */

/**
 * One scalar field's before/after.
 *
 * `null` on either side means the field is absent — the file carries no such tag,
 * or the merge proposes clearing it. `changed` is the precomputed verdict so the
 * renderer never re-derives equality (and so a null-vs-null non-change is decided
 * once, in one place).
 */
export interface FieldDiff<T> {
  /** What the file holds now, from a fresh read. `null` when the file omits it. */
  readonly current: T | null
  /** What the merged correction layers say it should hold. `null` clears it. */
  readonly proposed: T | null
  /** Whether `proposed` differs from `current`. Precomputed by the merge. */
  readonly changed: boolean
}

/**
 * One genre in a diff: its grouping identity and its display spelling.
 *
 * The same `{ key, label }` pair the rest of the app groups genres by — `key` is
 * the casefolded identity from `@shared/genre`'s `normalizeLabel`, `label` is the
 * spelling that key is written to the file with. A genre frame is a *set*, so a
 * genre diff compares lists of these rather than one string.
 */
export interface GenreValue {
  /** Casefolded, whitespace-collapsed grouping identity. */
  readonly key: string
  /** The display spelling written to the file for this key. */
  readonly label: string
}

/**
 * The genre field's before/after — multi-valued, unlike every other field.
 *
 * `current` is the file's present genre frame, split the same way the scanner
 * derives `track_genres`. `proposed` is the merged set: the base genres (the
 * operator's `genre` override, or the file's own when there is none) with the
 * user/suggested tag layer unioned on and canonicalization applied. `changed` is
 * true when the two lists differ in identity *or* spelling *or* order — any of
 * which is a real change to the bytes.
 */
export interface GenreDiff {
  readonly current: readonly GenreValue[]
  readonly proposed: readonly GenreValue[]
  readonly changed: boolean
}

/**
 * A track's complete pending write — every writable field's diff, plus the one
 * summary flag the review and flush both branch on.
 *
 * The fields are named rather than a list so each keeps its own value type and no
 * consumer has to narrow a union to read a track number. `hasChanges` is true
 * when any field changed: a pending write with `hasChanges: false` is a track
 * whose file already matches its corrections, kept in the batch so the report can
 * say "nothing to do" rather than dropped and made invisible.
 */
export interface PendingWrite {
  readonly trackId: number
  readonly title: FieldDiff<string>
  readonly artist: FieldDiff<string>
  readonly album: FieldDiff<string>
  readonly trackNo: FieldDiff<number>
  readonly discNo: FieldDiff<number>
  readonly year: FieldDiff<number>
  readonly genres: GenreDiff
  /** True when at least one field's `changed` is set. */
  readonly hasChanges: boolean
}

/**
 * The staged review surface — **W16-6**, design authority D28 → "Staged review UI".
 *
 * Everything below is the wire between the review surface (renderer) and the
 * flush (main): the field keys the operator selects, the batch they approve, and
 * the outcome each file comes back with. It sits in `src/shared` for the same
 * reason the diff above does — the review draws it, main flushes it, and the two
 * cannot be allowed to disagree about the shape.
 */

/**
 * The writable fields of a pending write, as keys — the unit the review selects
 * and deselects and the flush applies one at a time.
 *
 * The same names {@link PendingWrite} carries, minus its identity and summary
 * fields. A selection is a subset of these per track; the flush writes a field's
 * `proposed` value only when its key is selected, and keeps the file's current
 * value for the rest.
 */
export type WritebackField = 'title' | 'artist' | 'album' | 'trackNo' | 'discNo' | 'year' | 'genres'

/** Every writable field, in the order the review surface lays them out. */
export const WRITEBACK_FIELDS: readonly WritebackField[] = [
  'title',
  'artist',
  'album',
  'trackNo',
  'discNo',
  'year',
  'genres'
]

/**
 * The most tracks one preview or flush request may carry.
 *
 * Generous enough for the "multi-thousand-track" batch the review is built for —
 * and for an album/artist/whole-selection scope — while bounding the fresh file
 * reads a single request can trigger. A caller with more chunks against it.
 */
export const MAX_WRITEBACK_TRACKS = 50_000

/**
 * One track's approved fields to flush — the subset of {@link WRITEBACK_FIELDS}
 * the operator left checked after reviewing its diff.
 *
 * A field absent from `fields` keeps the file's current value even where its
 * diff changed. A track the operator deselected entirely is not sent at all —
 * the batch carries only the writes that were asked for.
 */
export interface WritebackSelection {
  readonly trackId: number
  readonly fields: readonly WritebackField[]
}

/**
 * Why a flush did not write one file — the renderer-safe mirror of the engine's
 * failure code.
 *
 * The engine's own `WriteOutcome` carries a `reason` string and the absolute
 * `path`, and neither crosses the boundary: the reason can quote an OS error
 * that names the file, and an absolute path never reaches the renderer by
 * standing invariant. Only the typed code survives — the part the report
 * branches on — and the detail is logged in main.
 */
export type WritebackFailureCode = 'unsupported-format' | 'write-failed' | 'verify-failed'

/**
 * One file's result, keyed by track for the renderer.
 *
 * `written` is a completed atomic write; `skipped` is a track whose selected
 * fields needed no change against a fresh read (the file already matched, or a
 * diff that changed at review time no longer does); `failed` carries only the
 * typed {@link WritebackFailureCode}. No path, no raw reason — see that type.
 */
export type WritebackOutcome =
  | { readonly trackId: number; readonly status: 'written' }
  | { readonly trackId: number; readonly status: 'skipped' }
  | { readonly trackId: number; readonly status: 'failed'; readonly code: WritebackFailureCode }

/**
 * Cumulative progress of a flush, pushed as it runs — the live half of the
 * review's feedback.
 *
 * Counts rather than per-file rows: the event is coalesced in main so a
 * multi-thousand batch cannot flood the renderer (the frozen-Cancel failure
 * mode), and the per-file detail lands once in the final {@link WritebackReport}.
 * `done` equals `written + skipped + failed`.
 */
export interface WritebackProgress {
  readonly done: number
  readonly total: number
  readonly written: number
  readonly skipped: number
  readonly failed: number
}

/**
 * The complete result of a flush — the per-file summary the review shows when
 * the batch finishes.
 *
 * Returned by `tagWriteback.apply` so a renderer that missed a coalesced
 * progress event still has every outcome. `total` is the number of selections
 * the batch was asked to write; `cancelled` is true when the operator stopped it
 * mid-batch, in which case `outcomes` covers only the files it reached.
 */
export interface WritebackReport {
  readonly total: number
  readonly written: number
  readonly skipped: number
  readonly failed: number
  readonly cancelled: boolean
  readonly outcomes: readonly WritebackOutcome[]
}
