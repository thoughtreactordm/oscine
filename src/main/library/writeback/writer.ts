import { extname } from 'node:path'
import type { File as TagFile } from 'node-taglib-sharp'
import type { FieldDiff, GenreValue, PendingWrite, WritebackField } from '@shared/tagWriteback'

/**
 * The per-codec tag writer — **W16-3**, design authority `oscine-tag-writeback`
 * → "The write engine". Owns **R6 (tag-write corruption)**'s field-mapping half;
 * `engine.ts` owns the atomic-IO half.
 *
 * ## Per-codec writers, behind one interface
 *
 * D28 wants "per-codec writers behind one interface: an ID3v2 writer for mp3/aac
 * and a Vorbis-comment writer for flac/vorbis/opus". `node-taglib-sharp` already
 * *is* that interface: its `Tag` abstraction routes one set of setters to the tag
 * family a container actually uses — ID3v2 on an mp3, a Xiph comment on a
 * flac/ogg/opus, and the iTunes atoms on an mp4/m4a (which is how the v1 "aac"
 * codec is actually stored, MP4-wrapped, not as raw ADTS with an ID3 tail). The
 * per-codec decision that remains in *our* code is therefore not a second write
 * path per family — that would duplicate identical setter calls and diverge from
 * the exact CombinedTag path the W16-3 corpus gate proves green on all five
 * codecs — but two things this file owns:
 *
 *   1. **The in-set gate.** {@link resolveCodecWriter} maps a file's extension to
 *      one of the five v1 codecs, or refuses. "Refuses out-of-set formats
 *      explicitly" is a literal acceptance criterion — a `.wav` or a `.wma` must
 *      never reach the container.
 *   2. **The field mapping.** {@link applyWritableTags} sets exactly the scalar
 *      fields the diff models and *nothing else*, so artwork, custom frames and
 *      every unmodelled tag survive the write untouched — the corpus's
 *      `preserved:*` checks.
 *
 * The `tagFamily` each writer declares is documentation of the routing above and
 * the label a per-file report names; the bytes are written through the container
 * taglib opened, which is what makes the routing correct rather than asserted.
 */

/** The five codecs D28 writes in v1. Anything else is refused. */
export type WritebackCodec = 'flac' | 'mp3' | 'vorbis' | 'opus' | 'aac'

/** The tag family a codec's container stores its tags in. */
export type TagFamily = 'vorbis' | 'id3v2' | 'mp4'

/** One codec's write descriptor: what it is, and which tag family it routes to. */
export interface CodecWriter {
  readonly codec: WritebackCodec
  readonly tagFamily: TagFamily
}

/**
 * Extension → codec, the explicit in-set gate.
 *
 * Keyed by the lower-cased extension `node:path` reports (leading dot included).
 * The set mirrors the W16-3 corpus's five files plus the obvious container
 * variants: `.oga` is Ogg-Vorbis and `.mp4` is an MP4/AAC the same way `.m4a`
 * is. An `.ogg` carrying Opus still writes a Xiph comment — the tag family is
 * right regardless of which codec the Ogg wraps — so the reported `codec` label
 * is a best-effort read of the extension while the write itself is not.
 */
const BY_EXTENSION: ReadonlyMap<string, CodecWriter> = new Map([
  ['.flac', { codec: 'flac', tagFamily: 'vorbis' }],
  ['.mp3', { codec: 'mp3', tagFamily: 'id3v2' }],
  ['.ogg', { codec: 'vorbis', tagFamily: 'vorbis' }],
  ['.oga', { codec: 'vorbis', tagFamily: 'vorbis' }],
  ['.opus', { codec: 'opus', tagFamily: 'vorbis' }],
  ['.m4a', { codec: 'aac', tagFamily: 'mp4' }],
  ['.mp4', { codec: 'aac', tagFamily: 'mp4' }]
])

/**
 * The codec writer for a path, or `null` when the format is out of the v1 set.
 *
 * `null` is the explicit refusal the engine turns into an `unsupported-format`
 * outcome — the write never opens the file, so a format we cannot round-trip is
 * rejected before a single byte is at risk.
 */
export function resolveCodecWriter(absPath: string): CodecWriter | null {
  return BY_EXTENSION.get(extname(absPath).toLowerCase()) ?? null
}

/** The resolved target values a flush writes into a file's tags. */
export interface WritableTags {
  readonly title: string | null
  readonly artist: string | null
  readonly album: string | null
  readonly trackNo: number | null
  readonly discNo: number | null
  readonly year: number | null
  /** The proposed genre frame, written as one delimited string. */
  readonly genres: readonly GenreValue[]
}

/**
 * The genre frame as the one delimited string a scan reads back to the same set.
 *
 * The app reads a file's genres as `splitGenres(primaryGenre(common.genre))`: the
 * *first* genre value, then split on `;`, `/`, `,`. Writing one native frame per
 * genre therefore loses everything after the first on the next scan, so the only
 * form that survives the app's own pipeline is a single `'; '`-joined value — the
 * same convention the W16-3 corpus documents and verifies. An empty frame yields
 * an empty list, which clears the tag.
 */
export function writtenGenreValue(genres: readonly GenreValue[]): string[] {
  return genres.length === 0 ? [] : [genres.map((genre) => genre.label).join('; ')]
}

/**
 * Sets exactly the modelled scalar fields on an opened file's tag, nothing else.
 *
 * Every proposed field is written unconditionally — an unchanged field is
 * re-written to its own value, which is a no-op in content — so the file ends
 * holding the full merged state. A `null` proposal clears the field: an empty
 * string or list, or `0`, are node-taglib-sharp's "unset" for these, and the app
 * reader normalises a blank read back to `null` besides. Fields the diff does not
 * model — album artist, ReplayGain, artwork, any custom frame — are never
 * touched here, which is what preserves them across the save.
 */
export function applyWritableTags(file: TagFile, desired: WritableTags): void {
  const tag = file.tag
  tag.title = desired.title ?? ''
  tag.performers = desired.artist === null ? [] : [desired.artist]
  tag.album = desired.album ?? ''
  tag.genres = writtenGenreValue(desired.genres)
  tag.year = desired.year ?? 0
  tag.track = desired.trackNo ?? 0
  tag.disc = desired.discNo ?? 0
}

/**
 * The bridge from a reviewed pending write (W16-1) to the engine's input.
 *
 * A `PendingWrite` carries both sides of every field; the flush wants only the
 * `proposed` side — the merged target the operator approved. Kept here so the
 * engine's public input is the small {@link WritableTags} and not the whole diff.
 */
export function writableTagsFromPending(pending: PendingWrite): WritableTags {
  return {
    title: pending.title.proposed,
    artist: pending.artist.proposed,
    album: pending.album.proposed,
    trackNo: pending.trackNo.proposed,
    discNo: pending.discNo.proposed,
    year: pending.year.proposed,
    genres: pending.genres.proposed
  }
}

/** Whether one scalar field's key is selected: `proposed` if so, else `current`. */
function pick<T extends string | number>(
  field: WritebackField,
  diff: FieldDiff<T>,
  selected: ReadonlySet<WritebackField>
): T | null {
  return selected.has(field) ? diff.proposed : diff.current
}

/**
 * A flush target honouring the review's per-field selection — **W16-6**.
 *
 * The engine rewrites the whole tag block, so a deselected field cannot simply
 * be omitted: it is written back at its *current* value, which the file already
 * holds, so the write is a content no-op for it and every unmodelled tag it
 * carries survives untouched. Only the selected fields take their `proposed`
 * value. `current` here is the field's fresh read from the pending write the
 * flush re-derived at apply time (R7), never a value the renderer supplied — so
 * a field the operator left unchecked keeps whatever the file holds now, even if
 * another tool changed it since the diff was reviewed.
 */
export function writableTagsFromSelection(
  pending: PendingWrite,
  selected: ReadonlySet<WritebackField>
): WritableTags {
  return {
    title: pick('title', pending.title, selected),
    artist: pick('artist', pending.artist, selected),
    album: pick('album', pending.album, selected),
    trackNo: pick('trackNo', pending.trackNo, selected),
    discNo: pick('discNo', pending.discNo, selected),
    year: pick('year', pending.year, selected),
    genres: selected.has('genres') ? pending.genres.proposed : pending.genres.current
  }
}

/**
 * Whether a selection still changes anything against a freshly re-derived diff.
 *
 * True when at least one selected field is genuinely changed in `pending`. False
 * is the flush's "skip this file" signal: every selected field already matches
 * the bytes on disk — either the file always did, or an out-of-band edit made it
 * so since review — so writing would be a no-op and the report says `skipped`.
 */
export function selectionChangesFile(
  pending: PendingWrite,
  selected: ReadonlySet<WritebackField>
): boolean {
  if (selected.has('title') && pending.title.changed) return true
  if (selected.has('artist') && pending.artist.changed) return true
  if (selected.has('album') && pending.album.changed) return true
  if (selected.has('trackNo') && pending.trackNo.changed) return true
  if (selected.has('discNo') && pending.discNo.changed) return true
  if (selected.has('year') && pending.year.changed) return true
  if (selected.has('genres') && pending.genres.changed) return true
  return false
}
