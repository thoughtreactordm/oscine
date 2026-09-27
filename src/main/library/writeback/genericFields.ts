import { File as TagFile, type Tag } from 'node-taglib-sharp'
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
 * node-taglib-sharp `Tag` property its registry entry names. Not `music-metadata`
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
  const properties = tag as unknown as TagProperties
  const values = new Map<TagFieldKey, TagFieldValue | null>()
  for (const key of keys) {
    const field = tagField(key)
    if (field === undefined) continue
    values.set(key, canonicalTagValue(field, properties[field.taglib]))
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

  const properties = tag as unknown as TagProperties
  for (const [key, value] of Object.entries(fields) as Array<[string, TagFieldValue | null]>) {
    const field = tagField(key) as TagFieldDef
    if (value === null) {
      properties[field.taglib] = clearedValue(field)
    } else {
      properties[field.taglib] = Array.isArray(value) ? [...value] : value
    }
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
