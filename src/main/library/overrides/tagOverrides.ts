import type Database from 'better-sqlite3'
import {
  TAG_FIELDS,
  tagField,
  type TagFieldDef,
  type TagFieldKey,
  type TagFieldPatch,
  type TagFieldValue
} from '@shared/tagFields'

/**
 * The generic correction layer's store — **W16-15**, Decision E.
 *
 * One `track_tag_overrides` row per (track, field): a JSON value sets the
 * field, JSON `null` clears the frame on flush, and no row leaves the file's own
 * value. Unlike the grouped tier nothing here is materialised into the display
 * rows — no generic field is indexed, so a set is a row and nothing else, and
 * the browse needs no reload.
 *
 * **Unknown keys are preserved.** A row whose `field` this build's registry does
 * not know, or whose stored value no longer fits the field's kind, is skipped on
 * read and never deleted by anything here — a branch switch or a withdrawn field
 * must not destroy a correction. Only the `tracks` cascade removes such a row.
 */

/** A track's generic corrections: field → set value, or `null` for a clear. */
export type TagOverrideMap = ReadonlyMap<TagFieldKey, TagFieldValue | null>

/** Whether a decoded JSON value has the shape a field of this kind holds. */
function fitsKind(field: TagFieldDef, value: unknown): value is TagFieldValue {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string'
    case 'int':
      return typeof value === 'number' && Number.isInteger(value)
    case 'real':
      return typeof value === 'number' && Number.isFinite(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'list':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  }
}

/** A stored row's value, or `undefined` when this build cannot interpret it. */
function decode(field: TagFieldDef, json: string): TagFieldValue | null | undefined {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (value === null) return null
  return fitsKind(field, value) ? value : undefined
}

const KNOWN_KEYS: readonly string[] = TAG_FIELDS.map((field) => field.key)

export class TagOverrideStore {
  private readonly upsert: Database.Statement
  private readonly remove: Database.Statement
  private readonly selectForTrack: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.upsert = db.prepare(
      `INSERT INTO track_tag_overrides (track_id, field, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(track_id, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    this.remove = db.prepare('DELETE FROM track_tag_overrides WHERE track_id = ? AND field = ?')
    this.selectForTrack = db.prepare(
      'SELECT field, value FROM track_tag_overrides WHERE track_id = ? ORDER BY field'
    )
  }

  /**
   * Applies a generic edit to a batch in one transaction. Each field present in
   * the patch is upserted on every track — a value to set, `null` to clear —
   * and a field absent from the patch is left alone. Validation is the IPC
   * boundary's; this stores what it is given.
   */
  set(trackIds: readonly number[], patch: TagFieldPatch, now: number): void {
    const entries = Object.entries(patch).map(
      ([field, value]) => [field, JSON.stringify(value ?? null)] as const
    )
    const unique = [...new Set(trackIds)]
    if (entries.length === 0 || unique.length === 0) return
    this.db.transaction(() => {
      for (const trackId of unique) {
        for (const [field, json] of entries) this.upsert.run(trackId, field, json, now)
      }
    })()
  }

  /** Drops the named fields' rows on a batch — back to each file's own value. */
  revert(trackIds: readonly number[], fields: readonly TagFieldKey[]): void {
    const unique = [...new Set(trackIds)]
    if (fields.length === 0 || unique.length === 0) return
    this.db.transaction(() => {
      for (const trackId of unique) {
        for (const field of fields) this.remove.run(trackId, field)
      }
    })()
  }

  /**
   * Drops every correction this build understands — the generic half of
   * "discard all". Rows under unknown keys survive, per the preservation rule.
   */
  revertAll(): void {
    this.db
      .prepare(
        `DELETE FROM track_tag_overrides WHERE field IN (${KNOWN_KEYS.map(() => '?').join(', ')})`
      )
      .run(...KNOWN_KEYS)
  }

  /** One track's corrections, registry fields only, in key order. */
  get(trackId: number): TagOverrideMap {
    const rows = this.selectForTrack.all(trackId) as Array<{ field: string; value: string }>
    const result = new Map<TagFieldKey, TagFieldValue | null>()
    for (const row of rows) {
      const field = tagField(row.field)
      if (field === undefined) continue
      const value = decode(field, row.value)
      if (value !== undefined) result.set(field.key as TagFieldKey, value)
    }
    return result
  }

  /** {@link get} for a batch; tracks with no correction map to an empty map. */
  getMany(trackIds: readonly number[]): Map<number, TagOverrideMap> {
    const result = new Map<number, TagOverrideMap>()
    for (const trackId of new Set(trackIds)) result.set(trackId, this.get(trackId))
    return result
  }
}
