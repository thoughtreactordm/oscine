import type { FieldDiff, GenreValue, PendingWrite, WritebackSelection } from '@shared/tagWriteback'
import {
  WRITEBACK_FIELDS,
  isGroupedWritebackField,
  type GroupedWritebackField,
  type WritebackField
} from '@shared/tagWriteback'
import { TAG_FIELDS, type TagFieldDef, type TagFieldValue } from '@shared/tagFields'
import type { ArtworkRef } from '@shared/artwork'
import { formatTagValue } from '../tagFieldForm'

/**
 * The staged review's selection model — **W16-6**, the pure half.
 *
 * Everything the review surface reasons about that is not Vue: which fields a
 * pending write changed, the default all-selected state, the batch the checkbox
 * state resolves to, and the summaries the header and per-row controls read.
 * Kept out of the store so it is testable without Pinia or a browser — the same
 * split `listViewport`'s `visibleRange` draws for the geometry.
 */

/** Per-track selection: the field keys the operator has left checked. */
export type SelectionMap = Map<number, Set<WritebackField>>

/**
 * The human name each grouped field wears in the diff table's column and cells.
 * A generic field wears its registry label instead — see {@link fieldLabel}.
 */
export const FIELD_LABELS: Record<GroupedWritebackField, string> = {
  title: 'Title',
  artist: 'Artist',
  albumArtist: 'Album artist',
  album: 'Album',
  trackNo: 'Track №',
  discNo: 'Disc №',
  year: 'Year',
  genres: 'Genres',
  artwork: 'Cover'
}

/**
 * A pending write's generic diff for one registry key. Read through a string
 * index so a registry entry a test adds (not in {@link TagFieldKey}) resolves
 * the same way a shipped one does.
 */
function genericDiff(pending: PendingWrite, key: string): FieldDiff<TagFieldValue> | undefined {
  return (pending.fields as Readonly<Record<string, FieldDiff<TagFieldValue> | undefined>>)[key]
}

/** Whether one field of a pending write differs from the file — the `changed` flag. */
export function fieldChanged(pending: PendingWrite, field: WritebackField): boolean {
  if (!isGroupedWritebackField(field)) return genericDiff(pending, field)?.changed ?? false
  switch (field) {
    case 'title':
      return pending.title.changed
    case 'artist':
      return pending.artist.changed
    case 'albumArtist':
      return pending.albumArtist.changed
    case 'album':
      return pending.album.changed
    case 'trackNo':
      return pending.trackNo.changed
    case 'discNo':
      return pending.discNo.changed
    case 'year':
      return pending.year.changed
    case 'genres':
      return pending.genres.changed
    case 'artwork':
      return pending.artwork.changed
  }
}

/** Every writable key in canonical order: the grouped columns, then the registry's. */
function orderedFields(registry: readonly TagFieldDef[]): WritebackField[] {
  return [...WRITEBACK_FIELDS, ...registry.map((field) => field.key as WritebackField)]
}

/**
 * A pending write's changed fields, in canonical order — grouped first, then
 * generic in registry order (**W16-18**: the review selects both tiers).
 */
export function changedFields(
  pending: PendingWrite,
  registry: readonly TagFieldDef[] = TAG_FIELDS
): WritebackField[] {
  return orderedFields(registry).filter((field) => fieldChanged(pending, field))
}

/**
 * The diff grid's columns: every grouped field, as before, then only the
 * generic fields some track in the batch actually changes. The registry has
 * some thirty keys, and a column per key would bury the handful in play.
 */
export function reviewColumns(
  pendings: readonly PendingWrite[],
  registry: readonly TagFieldDef[] = TAG_FIELDS
): WritebackField[] {
  const generic = registry
    .filter((field) =>
      pendings.some((pending) => fieldChanged(pending, field.key as WritebackField))
    )
    .map((field) => field.key as WritebackField)
  return [...WRITEBACK_FIELDS, ...generic]
}

/** A column's heading: the grouped label, or the registry's for a generic key. */
export function fieldLabel(
  field: WritebackField,
  registry: readonly TagFieldDef[] = TAG_FIELDS
): string {
  if (isGroupedWritebackField(field)) return FIELD_LABELS[field]
  return registry.find((entry) => entry.key === field)?.label ?? field
}

/**
 * The default selection when a review opens: every changed field of every track.
 *
 * The strongest reading of D28's "explicit and staged" is still that the
 * operator's first act is to *deselect*, not to hunt for what to turn on — the
 * batch they reviewed is the batch they meant, minus anything they vetoed.
 */
export function initialSelection(
  pendings: readonly PendingWrite[],
  registry: readonly TagFieldDef[] = TAG_FIELDS
): SelectionMap {
  const map: SelectionMap = new Map()
  for (const pending of pendings) {
    map.set(pending.trackId, new Set(changedFields(pending, registry)))
  }
  return map
}

/**
 * The batch to flush: every track with at least one selected field, fields in
 * canonical order.
 *
 * A track the operator deselected entirely is dropped — the wire carries only
 * the writes that were asked for, which is what {@link WritebackSelection}'s
 * contract promises main.
 */
export function buildSelections(
  pendings: readonly PendingWrite[],
  selection: SelectionMap,
  registry: readonly TagFieldDef[] = TAG_FIELDS
): WritebackSelection[] {
  const order = orderedFields(registry)
  const out: WritebackSelection[] = []
  for (const pending of pendings) {
    const selected = selection.get(pending.trackId)
    if (selected === undefined || selected.size === 0) continue
    const fields = order.filter((field) => selected.has(field))
    if (fields.length > 0) out.push({ trackId: pending.trackId, fields })
  }
  return out
}

/** How many tracks and fields the current selection would write. */
export interface SelectionSummary {
  readonly tracks: number
  readonly fields: number
}

export function selectionSummary(
  pendings: readonly PendingWrite[],
  selection: SelectionMap
): SelectionSummary {
  let tracks = 0
  let fields = 0
  for (const pending of pendings) {
    const size = selection.get(pending.trackId)?.size ?? 0
    if (size > 0) {
      tracks += 1
      fields += size
    }
  }
  return { tracks, fields }
}

/** A checkbox's three states — the row and header controls are tri-state. */
export type CheckState = 'all' | 'some' | 'none'

/** A row's state: `all`/`some`/`none` of its *changed* fields selected. */
export function rowState(pending: PendingWrite, selection: SelectionMap): CheckState {
  const changed = changedFields(pending)
  if (changed.length === 0) return 'none'
  const selected = selection.get(pending.trackId)
  const on = selected ? changed.filter((field) => selected.has(field)).length : 0
  if (on === 0) return 'none'
  return on === changed.length ? 'all' : 'some'
}

/** The whole batch's state, for the header's select-all control. */
export function overallState(
  pendings: readonly PendingWrite[],
  selection: SelectionMap
): CheckState {
  let anyOn = false
  let anyOff = false
  for (const pending of pendings) {
    const state = rowState(pending, selection)
    if (state === 'some') return 'some'
    if (state === 'all') anyOn = true
    else anyOff = true
    if (anyOn && anyOff) return 'some'
  }
  if (!anyOn) return 'none'
  return anyOff ? 'some' : 'all'
}

/** The label a diff row identifies its track by, derived from the diff itself. */
export interface RowLabel {
  readonly primary: string
  readonly secondary: string
}

export function rowLabel(pending: PendingWrite): RowLabel {
  const title = pending.title.current ?? pending.title.proposed
  const artist = pending.artist.current ?? pending.artist.proposed
  return { primary: title ?? `Track ${pending.trackId}`, secondary: artist ?? '' }
}

/** A scalar field's display: an em dash stands in for an absent value. */
export function formatScalar(value: string | number | null): string {
  return value === null ? '—' : String(value)
}

/** A genre frame's display: its labels, comma-joined, or an em dash when empty. */
export function formatGenres(values: readonly GenreValue[]): string {
  return values.length === 0 ? '—' : values.map((value) => value.label).join(', ')
}

/**
 * A cover reference's display when there is no thumbnail to draw.
 *
 * `—` is none (the file has no cover). `✕ remove` is a proposed clear: the
 * file has a cover and the override strips it.
 */
export function formatArtwork(
  ref: ArtworkRef,
  role: 'current' | 'proposed',
  other: ArtworkRef
): string {
  if (ref.present) return ref.mime ?? 'cover'
  if (role === 'proposed' && other.present) return '✕ remove'
  return '—'
}

/** One field's before/after as display strings, for a diff cell. */
export interface FieldText {
  readonly current: string
  readonly proposed: string
}

export function fieldText(
  pending: PendingWrite,
  field: WritebackField,
  registry: readonly TagFieldDef[] = TAG_FIELDS
): FieldText {
  if (!isGroupedWritebackField(field)) {
    const def = registry.find((entry) => entry.key === field)
    const diff = genericDiff(pending, field)
    if (def === undefined || diff === undefined) return { current: '—', proposed: '—' }
    return {
      current: formatTagValue(def, diff.current),
      proposed: formatTagValue(def, diff.proposed)
    }
  }
  switch (field) {
    case 'title':
      return {
        current: formatScalar(pending.title.current),
        proposed: formatScalar(pending.title.proposed)
      }
    case 'artist':
      return {
        current: formatScalar(pending.artist.current),
        proposed: formatScalar(pending.artist.proposed)
      }
    case 'albumArtist':
      return {
        current: formatScalar(pending.albumArtist.current),
        proposed: formatScalar(pending.albumArtist.proposed)
      }
    case 'album':
      return {
        current: formatScalar(pending.album.current),
        proposed: formatScalar(pending.album.proposed)
      }
    case 'trackNo':
      return {
        current: formatScalar(pending.trackNo.current),
        proposed: formatScalar(pending.trackNo.proposed)
      }
    case 'discNo':
      return {
        current: formatScalar(pending.discNo.current),
        proposed: formatScalar(pending.discNo.proposed)
      }
    case 'year':
      return {
        current: formatScalar(pending.year.current),
        proposed: formatScalar(pending.year.proposed)
      }
    case 'genres':
      return {
        current: formatGenres(pending.genres.current),
        proposed: formatGenres(pending.genres.proposed)
      }
    case 'artwork':
      return {
        current: formatArtwork(pending.artwork.current, 'current', pending.artwork.proposed),
        proposed: formatArtwork(pending.artwork.proposed, 'proposed', pending.artwork.current)
      }
  }
}
