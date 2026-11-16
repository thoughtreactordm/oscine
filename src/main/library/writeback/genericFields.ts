import {
  CombinedTag,
  Id3v2CommentsFrame,
  Id3v2FrameClassType,
  Id3v2Tag,
  Mpeg4AppleTag,
  OggOpusCodec,
  File as TagFile,
  XiphComment,
  type Tag
} from 'node-taglib-sharp'
import { gainDbToR128Q78, parseR128Q78, r128Q78ToGainDb } from '@shared/audio/r128'
import {
  isFlushableTagField,
  tagField,
  tagFieldValuesEqual,
  type TagFieldDef,
  type TagFieldKey,
  type TagFieldPatch,
  type TagFieldValue
} from '@shared/tagFields'

/**
 * The generic tier's file IO — **W16-17**, design authority `oscine-tag-writeback`
 * → "The full tag surface", Decision E.
 *
 * Every generic field is read, written and verified through the one
 * node-taglib-sharp `Tag` property its registry entry names — through
 * {@link readTagProperty} / {@link writeTagProperty}, which swap in a safe
 * accessor where the portable one damages a neighbour. Not `music-metadata`
 * and not the scan path: the value the editor shows has to be in the
 * representation the writer writes and verify compares, and nothing here is ever
 * indexed into `tracks` — a generic value is read from the file on demand, each
 * time, which is also what makes the diff's `current` a fresh read (R7).
 *
 * ## One canonical value per kind
 *
 * taglib cannot tell "absent" from a kind's empty value: an unset text frame reads
 * back `undefined` (or `''`), an unset int `0`, an unset flag `false`, an unset
 * list `[]`. {@link canonicalTagValue} folds each of those to `null`, and it is
 * applied to *both* sides of every comparison — the file read and the correction
 * — so a correction that sets the compilation flag to `false` and a file with no
 * flag agree, rather than diffing forever against a frame no write can create.
 */

/** A generic field's values by key; `null` is "the file carries none". */
export type TagFieldValues = ReadonlyMap<TagFieldKey, TagFieldValue | null>

/**
 * The on-demand generic read: each named field's current value in `absPath`,
 * canonicalised. Injected wherever it is used so the diff, verify and prefill run
 * without a real audio file or the native tag library.
 */
export type TagFieldReader = (
  absPath: string,
  keys: readonly TagFieldKey[]
) => Promise<TagFieldValues>

/** node-taglib-sharp's `Tag`, addressed by the property name the registry holds. */
type TagProperties = Record<string, unknown>

/**
 * The file's concrete tags. A combined tag (an MP3's ID3v2 + APE + ID3v1, a FLAC's
 * Xiph comment + ID3v2) flattens to its leaves in the order its own getters read.
 */
function leafTags(tag: Tag): Tag[] {
  return tag instanceof CombinedTag ? tag.tags : [tag]
}

/** The ID3v2 COMM frames that *are* the comment: the ones with no description. */
function plainCommentFrames(tag: Id3v2Tag): Id3v2CommentsFrame[] {
  return tag
    .getFramesByClassType<Id3v2CommentsFrame>(Id3v2FrameClassType.CommentsFrame)
    .filter((frame) => frame.description === '')
}

/** The plain COMM frame the comment reads and writes: the tag's language first. */
function plainCommentFrame(tag: Id3v2Tag): Id3v2CommentsFrame | undefined {
  const frames = plainCommentFrames(tag)
  return frames.find((frame) => frame.language === Id3v2Tag.language) ?? frames[0]
}

/**
 * The comment, with ID3v2 read through its plain COMM frame — **W16-19**.
 *
 * node-taglib-sharp's own ID3v2 accessor picks a "preferred" COMM frame and, when
 * no frame has an empty description, falls back to a *described* one — a frame
 * another tool owns (`iTunNORM` aside, which it skips). Read through it, a file
 * whose only COMM frames are described shows one of them as its comment; written
 * through it, the edit overwrites that frame; cleared through it, every COMM frame
 * goes. Here an ID3v2 tag with no plain frame has no comment, and the next tag
 * (APE, ID3v1) answers, exactly as the combined getter would for a missing frame.
 *
 * A file with no ID3v2 tag goes through the portable accessor untouched, which
 * also keeps an Ogg's first-comment-only semantics out of this walk.
 */
function readComment(tag: Tag): unknown {
  const leaves = leafTags(tag)
  if (!leaves.some((leaf) => leaf instanceof Id3v2Tag)) return tag.comment
  for (const leaf of leaves) {
    const value = leaf instanceof Id3v2Tag ? plainCommentFrame(leaf)?.text : leaf.comment
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/**
 * Writes the comment to every tag, as the combined setter does, but ID3v2 only
 * through its plain COMM frame: a set updates that frame or adds one with an empty
 * description, and a clear removes the plain frames alone. Described COMM frames
 * are never touched.
 */
function writeComment(tag: Tag, value: unknown): void {
  const text = typeof value === 'string' && value !== '' ? value : undefined
  const leaves = leafTags(tag)
  if (!leaves.some((leaf) => leaf instanceof Id3v2Tag)) {
    tag.comment = text as string
    return
  }
  for (const leaf of leaves) {
    if (!(leaf instanceof Id3v2Tag)) {
      leaf.comment = text as string
    } else if (text === undefined) {
      for (const frame of plainCommentFrames(leaf)) leaf.removeFrame(frame)
    } else {
      let frame = plainCommentFrame(leaf)
      if (frame === undefined) {
        frame = Id3v2CommentsFrame.fromDescription('', Id3v2Tag.language)
        leaf.addFrame(frame)
      }
      frame.text = text
    }
  }
}

/** The plain `Tag` property, read as-is. */
function plainRead(property: string): (tag: Tag) => unknown {
  return (tag) => (tag as unknown as TagProperties)[property]
}

/**
 * A multi-valued MusicBrainz id, cleared on MP4 with `''` — **W16-20**.
 *
 * node-taglib-sharp's `AppleTag` stores these ids as one iTunes string per
 * `/`-separated id, and its setter splits the value before storing it, so the
 * text clear value (`undefined`) throws there. `''` splits to one empty id, which
 * the setter skips, leaving no box. Every other tag family takes the text clear as
 * it is. An MP4's tag is the Apple tag itself, never a combined one.
 */
function writeSplitId(property: string): (tag: Tag, value: unknown) => void {
  return (tag, value) => {
    const cleared = value === undefined || value === null || value === ''
    ;(tag as unknown as TagProperties)[property] =
      cleared && tag instanceof Mpeg4AppleTag ? '' : value
  }
}

/**
 * What an accessor needs to know about the file beyond its tag. Only one thing so
 * far: whether the Ogg stream is **Opus** — a Xiph comment cannot tell, and an
 * Opus file in an `.ogg` is still Opus, so this comes from the decoded codec,
 * never the extension.
 */
export interface TagAccessContext {
  readonly opus: boolean
}

/** Every non-Opus file, and any caller that has only a tag. */
export const PLAIN_TAG_CONTEXT: TagAccessContext = Object.freeze({ opus: false })

/** The access context of an open file. */
export function tagAccessContext(file: TagFile): TagAccessContext {
  const codecs = file.properties?.codecs ?? []
  return { opus: codecs.some((codec) => codec instanceof OggOpusCodec) }
}

/**
 * The Opus ReplayGain scopes — **W25-5 (RG-5)**, `oscine-replaygain` D37
 * Decision E. RFC 7845 §5.2.1 gives Opus `R128_TRACK_GAIN` / `R128_ALBUM_GAIN`
 * (Q7.8 integer, −23 LUFS reference, applied on top of the header output gain)
 * and no peak tag. node-taglib-sharp's `XiphComment` writes `REPLAYGAIN_*` on
 * any Ogg, which other Opus players ignore or double-apply, so an Opus gain goes
 * through the raw field instead, and the same scope's `REPLAYGAIN_*` gain and
 * peak are removed in the same write.
 */
const OPUS_GAIN_SCOPES: Readonly<Record<string, { r128: string; legacy: readonly string[] }>> = {
  replayGainTrackGain: {
    r128: 'R128_TRACK_GAIN',
    legacy: ['REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK']
  },
  replayGainAlbumGain: {
    r128: 'R128_ALBUM_GAIN',
    legacy: ['REPLAYGAIN_ALBUM_GAIN', 'REPLAYGAIN_ALBUM_PEAK']
  }
}

/** The ReplayGain peaks: R128 has no peak tag, so an Opus file is never given one. */
const OPUS_UNWRITABLE = new Set(['replayGainTrackPeak', 'replayGainAlbumPeak'])

function xiphComments(tag: Tag): XiphComment[] {
  return leafTags(tag).filter((leaf): leaf is XiphComment => leaf instanceof XiphComment)
}

/**
 * An Opus gain: the scope's `R128_*` as ReplayGain 2.0 dB when it parses, else
 * the `REPLAYGAIN_*` a foreign tagger left — the scanner's precedence (RG-2), so
 * the editor, the diff and the verify see what a rescan will.
 */
function readOpusGain(property: string): (tag: Tag) => unknown {
  const scope = OPUS_GAIN_SCOPES[property]!
  return (tag) => {
    for (const comment of xiphComments(tag)) {
      const q = parseR128Q78(comment.getFieldFirstValue(scope.r128) ?? '')
      if (q !== null) return r128Q78ToGainDb(q)
    }
    return (tag as unknown as TagProperties)[property]
  }
}

/**
 * Writes an Opus gain as `R128_*` on the first comment (the one an Ogg tag's own
 * setters write), after removing the scope's `R128_*` and `REPLAYGAIN_*` from
 * every comment. A clear (`undefined`, `null`, `NaN`) is the removal alone.
 */
function writeOpusGain(property: string): (tag: Tag, value: unknown) => void {
  const scope = OPUS_GAIN_SCOPES[property]!
  return (tag, value) => {
    const comments = xiphComments(tag)
    if (comments.length === 0) throw new Error(`no Xiph comment to write ${scope.r128} into`)
    const cleared = value === undefined || value === null || Number.isNaN(value)
    if (!cleared && typeof value !== 'number') {
      throw new TypeError(`${property} must be a number, got ${typeof value}`)
    }
    // Before any mutation: a gain Q7.8 cannot express throws with the file untouched.
    const text = cleared ? null : String(gainDbToR128Q78(value as number))
    for (const comment of comments) {
      comment.removeField(scope.r128)
      for (const legacy of scope.legacy) comment.removeField(legacy)
    }
    if (text !== null) comments[0]!.setFieldAsStrings(scope.r128, text)
  }
}

/** An Opus peak: never written (R128 has none). Read as the file holds it. */
function refuseOpusPeak(property: string): (tag: Tag, value: unknown) => void {
  return () => {
    throw new Error(`refusing ${property} on Opus: R128 has no peak tag (D37 Decision E)`)
  }
}

interface PropertyAccess {
  read(tag: Tag, context: TagAccessContext): unknown
  write(tag: Tag, value: unknown, context: TagAccessContext): void
}

/** The plain `Tag` property assignment. */
function plainWrite(property: string): (tag: Tag, value: unknown) => void {
  return (tag, value) => {
    ;(tag as unknown as TagProperties)[property] = value
  }
}

/** Plain on every codec but Opus, where `opus` decides. */
function opusAware(
  property: string,
  opus: { read(tag: Tag): unknown; write(tag: Tag, value: unknown): void }
): PropertyAccess {
  const read = plainRead(property)
  const write = plainWrite(property)
  return {
    read: (tag, context) => (context.opus ? opus.read(tag) : read(tag)),
    write: (tag, value, context) => (context.opus ? opus.write(tag, value) : write(tag, value))
  }
}

/**
 * The registry properties whose portable accessor is not safe to go through, and
 * what to use instead. Everything else is read and assigned as the plain `Tag`
 * property. `scripts/lib/writeback-tag-access.mjs` mirrors this for the W16-16
 * corpus gate, and `tests/tooling/writebackTagAccess.test.ts` pins the two.
 */
const PROPERTY_ACCESS: Readonly<Record<string, PropertyAccess>> = {
  comment: { read: readComment, write: writeComment },
  musicBrainzArtistId: {
    read: plainRead('musicBrainzArtistId'),
    write: writeSplitId('musicBrainzArtistId')
  },
  musicBrainzReleaseArtistId: {
    read: plainRead('musicBrainzReleaseArtistId'),
    write: writeSplitId('musicBrainzReleaseArtistId')
  },
  replayGainTrackGain: opusAware('replayGainTrackGain', {
    read: readOpusGain('replayGainTrackGain'),
    write: writeOpusGain('replayGainTrackGain')
  }),
  replayGainAlbumGain: opusAware('replayGainAlbumGain', {
    read: readOpusGain('replayGainAlbumGain'),
    write: writeOpusGain('replayGainAlbumGain')
  }),
  replayGainTrackPeak: opusAware('replayGainTrackPeak', {
    read: plainRead('replayGainTrackPeak'),
    write: refuseOpusPeak('replayGainTrackPeak')
  }),
  replayGainAlbumPeak: opusAware('replayGainAlbumPeak', {
    read: plainRead('replayGainAlbumPeak'),
    write: refuseOpusPeak('replayGainAlbumPeak')
  })
}

/** A registry property's raw value, through its safe accessor. */
export function readTagProperty(
  tag: Tag,
  property: string,
  context: TagAccessContext = PLAIN_TAG_CONTEXT
): unknown {
  const access = PROPERTY_ACCESS[property]
  return access !== undefined
    ? access.read(tag, context)
    : (tag as unknown as TagProperties)[property]
}

/** Assigns a registry property's raw value, through its safe accessor. */
export function writeTagProperty(
  tag: Tag,
  property: string,
  value: unknown,
  context: TagAccessContext = PLAIN_TAG_CONTEXT
): void {
  const access = PROPERTY_ACCESS[property]
  if (access !== undefined) access.write(tag, value, context)
  else (tag as unknown as TagProperties)[property] = value
}

/**
 * A value in the kind's canonical form, or `null` for the kind's empty value.
 *
 * Text keeps its exact content (the IPC validator does not trim, so neither does
 * this) and folds only `''`. An int is a positive integer or absent — `0` is
 * taglib's unset and the registry's minimum is 1. A flag is `true` or absent. A
 * list is its string entries in order, or absent when there are none. A value
 * that does not fit the kind at all reads as absent rather than throwing: a
 * malformed frame is something the operator can overwrite, not a crash.
 */
export function canonicalTagValue(field: TagFieldDef, value: unknown): TagFieldValue | null {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string' && value !== '' ? value : null
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
    case 'real':
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    case 'bool':
      return value === true ? true : null
    case 'list': {
      if (!Array.isArray(value)) return null
      const entries = value.filter((entry): entry is string => typeof entry === 'string')
      return entries.length === 0 ? null : entries
    }
  }
}

/**
 * What a clear assigns, per kind — the shapes W16-16's corpus gate proves remove
 * the frame and nothing else (`CLEAR_VALUE` in `scripts/lib/writeback-field-cases.mjs`).
 */
function clearedValue(field: TagFieldDef): unknown {
  switch (field.kind) {
    case 'text':
      return undefined
    case 'list':
      return []
    case 'int':
      return 0
    case 'bool':
      return false
    case 'real':
      // `NaN`, not `undefined`: node-taglib-sharp's Apple ReplayGain setters test
      // `Number.isNaN` and then call `toFixed`, so `undefined` throws on MP4. Every
      // family removes the frame on `NaN` (RG-5's `written:<field>:clear` rows).
      return Number.NaN
  }
}

/** Every named field's current value on an open tag, canonicalised. */
export function readTagFieldsFromTag(
  tag: Tag,
  keys: readonly TagFieldKey[],
  context: TagAccessContext = PLAIN_TAG_CONTEXT
): Map<TagFieldKey, TagFieldValue | null> {
  const values = new Map<TagFieldKey, TagFieldValue | null>()
  for (const key of keys) {
    const field = tagField(key)
    if (field === undefined) continue
    values.set(key, canonicalTagValue(field, readTagProperty(tag, field.taglib, context)))
  }
  return values
}

/** The default reader: open the file through taglib, read the fields, close it. */
export const readTagFields: TagFieldReader = async (absPath, keys) => {
  const file = TagFile.createFromPath(absPath)
  try {
    return readTagFieldsFromTag(file.tag, keys, tagAccessContext(file))
  } finally {
    file.dispose()
  }
}

/**
 * The first key in `fields` the write-back may not flush, or `null` when every
 * key is flushable.
 *
 * Flushable means known to the registry and admitted by its W16-16 corpus row
 * ({@link isFlushableTagField}). Read-only is *not* refused here (D37 Decision
 * B): who may stage a ReplayGain row is the hand-edit entry points' question,
 * not the writer's. The engine asks this again because hiding a field in the UI
 * is not the guarantee: a held field whose round-trip is red must never reach a
 * file.
 */
export function refusedTagField(fields: Iterable<string>): string | null {
  for (const key of fields) {
    const field = tagField(key)
    if (field === undefined || !isFlushableTagField(field)) return key
  }
  return null
}

/**
 * **R20 / OQ1 — the Opus write hold.** Whether an Opus `R128_*` gain we
 * computed may reach a file. `false` until the header-output-gain question is
 * settled against `rsgain` with a non-zero-output-gain fixture: `R128_*` is
 * applied *on top of* the header gain, so an analyzer that measured the stream
 * without it would put every written gain off by exactly that header gain. Today
 * the question is also moot — the worker's decoder rejects Opus outright (RG-2),
 * so no computed Opus gain exists to write. This is separate from the per-field
 * {@link isFlushableTagField} hold: lifting the ReplayGain fields for FLAC, MP3,
 * Vorbis and AAC must not lift it for Opus.
 */
export const OPUS_R128_WRITE_CONFIRMED = false

/**
 * The first key in `fields` that may not be written to an Opus file, with why,
 * or `null`. A peak never may (R128 has no peak tag — Decision E); a gain may
 * not while {@link OPUS_R128_WRITE_CONFIRMED} is `false`. Like a held key, a
 * refused key fails the file rather than being dropped from the write.
 */
export function refusedOpusTagField(
  fields: Iterable<string>,
  context: TagAccessContext
): { key: string; reason: string } | null {
  if (!context.opus) return null
  for (const key of fields) {
    const taglib = tagField(key)?.taglib
    if (taglib === undefined) continue
    if (OPUS_UNWRITABLE.has(taglib)) {
      return { key, reason: 'R128 has no peak tag, so an Opus file carries none' }
    }
    if (OPUS_GAIN_SCOPES[taglib] !== undefined && !OPUS_R128_WRITE_CONFIRMED) {
      return { key, reason: 'Opus R128 writes are held until R20 is confirmed against rsgain' }
    }
  }
  return null
}

/**
 * Sets exactly the generic fields present in `fields`, each through its registry
 * property; a key absent from the patch is never assigned, so the file's frame
 * for it survives the write untouched — the same contract album artist has had
 * since `c9ddc5d`. A value sets the field (a list as a native multi-value frame,
 * Decision G); `null` assigns the kind's cleared shape.
 *
 * Throws on a key that is not flushable, or not writable to this file's codec
 * ({@link refusedOpusTagField}). The engine refuses a non-flushable key before
 * the file is opened; this is the backstop for any other caller, and the only
 * gate for the Opus refusals, which need the opened file to know its codec.
 */
export function applyTagFields(
  tag: Tag,
  fields: TagFieldPatch,
  context: TagAccessContext = PLAIN_TAG_CONTEXT
): void {
  const refused = refusedTagField(Object.keys(fields))
  if (refused !== null) throw new Error(`refusing tag field ${refused}: not flushable`)
  const opus = refusedOpusTagField(Object.keys(fields), context)
  if (opus !== null) throw new Error(`refusing tag field ${opus.key}: ${opus.reason}`)

  for (const [key, value] of Object.entries(fields) as Array<[string, TagFieldValue | null]>) {
    const field = tagField(key) as TagFieldDef
    writeTagProperty(
      tag,
      field.taglib,
      value === null ? clearedValue(field) : Array.isArray(value) ? [...value] : value,
      context
    )
  }
}

/**
 * Whether the file now holds every written generic field, or the first that it
 * does not. Both sides go through {@link canonicalTagValue}, so a clear verifies
 * against an absent read and a list compares by ordered value.
 */
export function verifyTagFields(after: TagFieldValues, desired: TagFieldPatch): string | null {
  for (const [key, value] of Object.entries(desired) as Array<[string, TagFieldValue | null]>) {
    const field = tagField(key)
    if (field === undefined) return `${key}: not a tag field`
    const want = canonicalTagValue(field, value)
    const got = canonicalTagValue(field, after.get(field.key as TagFieldKey) ?? null)
    if (!tagFieldValuesEqual(field, got, want)) {
      return `${key}: expected ${JSON.stringify(want)} but file holds ${JSON.stringify(got)}`
    }
  }
  return null
}
