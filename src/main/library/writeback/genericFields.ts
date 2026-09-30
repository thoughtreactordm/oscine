import {
  CombinedTag,
  Id3v2CommentsFrame,
  Id3v2FrameClassType,
  Id3v2Tag,
  Mpeg4AppleTag,
  File as TagFile,
  type Tag
} from 'node-taglib-sharp'
import {
  isEditableTagField,
  tagField,
  tagValuesEqual,
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
 * The registry properties whose portable accessor is not safe to go through, and
 * what to use instead. Everything else is read and assigned as the plain `Tag`
 * property. `scripts/lib/writeback-tag-access.mjs` mirrors this for the W16-16
 * corpus gate, and `tests/tooling/writebackTagAccess.test.ts` pins the two.
 */
const PROPERTY_ACCESS: Readonly<
  Record<string, { read(tag: Tag): unknown; write(tag: Tag, value: unknown): void }>
> = {
  comment: { read: readComment, write: writeComment },
  musicBrainzArtistId: {
    read: plainRead('musicBrainzArtistId'),
    write: writeSplitId('musicBrainzArtistId')
  },
  musicBrainzReleaseArtistId: {
    read: plainRead('musicBrainzReleaseArtistId'),
    write: writeSplitId('musicBrainzReleaseArtistId')
  }
}

/** A registry property's raw value, through its safe accessor. */
export function readTagProperty(tag: Tag, property: string): unknown {
  const access = PROPERTY_ACCESS[property]
  return access !== undefined ? access.read(tag) : (tag as unknown as TagProperties)[property]
}

/** Assigns a registry property's raw value, through its safe accessor. */
export function writeTagProperty(tag: Tag, property: string, value: unknown): void {
  const access = PROPERTY_ACCESS[property]
  if (access !== undefined) access.write(tag, value)
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
      // Unreachable for a write: `real` fields are read-only and refused first.
      return undefined
  }
}

/** Every named field's current value on an open tag, canonicalised. */
export function readTagFieldsFromTag(
  tag: Tag,
  keys: readonly TagFieldKey[]
): Map<TagFieldKey, TagFieldValue | null> {
  const values = new Map<TagFieldKey, TagFieldValue | null>()
  for (const key of keys) {
    const field = tagField(key)
    if (field === undefined) continue
    values.set(key, canonicalTagValue(field, readTagProperty(tag, field.taglib)))
  }
  return values
}

/** The default reader: open the file through taglib, read the fields, close it. */
export const readTagFields: TagFieldReader = async (absPath, keys) => {
  const file = TagFile.createFromPath(absPath)
  try {
    return readTagFieldsFromTag(file.tag, keys)
  } finally {
    file.dispose()
  }
}

/**
 * The first key in `fields` the write-back may not flush, or `null` when every
 * key is flushable.
 *
 * Flushable means known to the registry, admitted by its W16-16 corpus row, and
 * not read-only — the same {@link isEditableTagField} question the IPC and the
 * editor ask. The engine asks it again because hiding a field in the UI is not
 * the guarantee: a held field whose round-trip is red must never reach a file.
 */
export function refusedTagField(fields: Iterable<string>): string | null {
  for (const key of fields) {
    const field = tagField(key)
    if (field === undefined || !isEditableTagField(field)) return key
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
 * Throws on a key that is not flushable. The engine refuses such a write before
 * the file is opened; this is the backstop for any other caller.
 */
export function applyTagFields(tag: Tag, fields: TagFieldPatch): void {
  const refused = refusedTagField(Object.keys(fields))
  if (refused !== null) throw new Error(`refusing tag field ${refused}: not flushable`)

  for (const [key, value] of Object.entries(fields) as Array<[string, TagFieldValue | null]>) {
    const field = tagField(key) as TagFieldDef
    writeTagProperty(
      tag,
      field.taglib,
      value === null ? clearedValue(field) : Array.isArray(value) ? [...value] : value
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
    if (!tagValuesEqual(got, want)) {
      return `${key}: expected ${JSON.stringify(want)} but file holds ${JSON.stringify(got)}`
    }
  }
  return null
}
