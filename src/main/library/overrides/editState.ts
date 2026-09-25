import { artworkRef, type ArtworkRef } from '@shared/artwork'
import type { OverrideEditState, OverrideFieldState } from '@shared/overrides'
import {
  tagValuesEqual,
  type TagFieldEditState,
  type TagFieldKey,
  type TagFieldValue
} from '@shared/tagFields'

/**
 * Aggregating an edit's prefill — the pure half of the metadata editor's read.
 *
 * One row per selected track, carrying each field's *effective* value (the
 * materialised display value) and whether that field is currently overridden.
 * Folding many tracks into one form state — a shared value, or "mixed" — is
 * arithmetic, so it lives here and is tested without a database.
 */
export interface OverrideEditRow {
  readonly title: string | null
  readonly artist: string | null
  /** The album artist the track is keyed under, or its pending correction. */
  readonly albumArtist: string | null
  readonly album: string | null
  readonly trackNo: number | null
  readonly discNo: number | null
  readonly year: number | null
  readonly genre: string | null
  /** SQLite booleans: 1 when the track carries an override for the field. */
  readonly ovTitle: number
  readonly ovArtist: number
  readonly ovAlbumArtist: number
  readonly ovAlbum: number
  readonly ovTrackNo: number
  readonly ovDiscNo: number
  readonly ovYear: number
  readonly ovGenre: number
  /** Override-aware cover hash (W16-9); null when cleared or the album has none. */
  readonly artworkHash: string | null
  readonly artworkMime: string | null
  readonly ovArtwork: number
}

/** One field folded across the batch: shared value or `mixed`, plus overridden. */
function fold<T>(
  values: readonly (T | null)[],
  overridden: readonly number[]
): OverrideFieldState<T> {
  const first = values.length > 0 ? values[0] : null
  const mixed = values.some((value) => value !== first)
  return {
    value: mixed ? null : first,
    mixed,
    overridden: overridden.some((flag) => flag === 1)
  }
}

export function buildOverrideEditState(rows: readonly OverrideEditRow[]): OverrideEditState {
  return {
    trackCount: rows.length,
    title: fold(
      rows.map((r) => r.title),
      rows.map((r) => r.ovTitle)
    ),
    artist: fold(
      rows.map((r) => r.artist),
      rows.map((r) => r.ovArtist)
    ),
    albumArtist: fold(
      rows.map((r) => r.albumArtist),
      rows.map((r) => r.ovAlbumArtist)
    ),
    album: fold(
      rows.map((r) => r.album),
      rows.map((r) => r.ovAlbum)
    ),
    trackNo: fold(
      rows.map((r) => r.trackNo),
      rows.map((r) => r.ovTrackNo)
    ),
    discNo: fold(
      rows.map((r) => r.discNo),
      rows.map((r) => r.ovDiscNo)
    ),
    year: fold(
      rows.map((r) => r.year),
      rows.map((r) => r.ovYear)
    ),
    genre: fold(
      rows.map((r) => r.genre),
      rows.map((r) => r.ovGenre)
    ),
    artwork: foldArtwork(rows)
  }
}

function foldArtwork(rows: readonly OverrideEditRow[]): OverrideFieldState<ArtworkRef> {
  const hashes = rows.map((r) => r.artworkHash)
  const first = hashes.length > 0 ? hashes[0] : null
  const mixed = hashes.some((hash) => hash !== first)
  const mime = mixed || rows.length === 0 ? null : rows[0].artworkMime
  return {
    value: mixed ? null : artworkRef(first ?? null, mime),
    mixed,
    overridden: rows.some((row) => row.ovArtwork === 1)
  }
}

/**
 * One track's generic fields for the editor's prefill — **W16-15**. `values`
 * holds each field's *effective* value: the file's own, overlaid by the track's
 * correction (a clear overlays as `null`). A field missing from `values` is
 * empty. `overridden` names the fields carrying a correction.
 */
export interface TagFieldEditRow {
  readonly values: ReadonlyMap<TagFieldKey, TagFieldValue | null>
  readonly overridden: ReadonlySet<TagFieldKey>
}

/**
 * Folds the generic fields across a batch — the same shared-value-or-`mixed`
 * rule as the grouped fields, except that equality is by value, so two tracks
 * whose composer lists hold the same names in the same order agree.
 */
export function buildTagFieldEditState(
  rows: readonly TagFieldEditRow[],
  fields: readonly TagFieldKey[]
): TagFieldEditState {
  const state: Partial<Record<TagFieldKey, OverrideFieldState<TagFieldValue>>> = {}
  for (const field of fields) {
    const values = rows.map((row) => row.values.get(field) ?? null)
    const first = values.length > 0 ? values[0] : null
    const mixed = values.some((value) => !tagValuesEqual(value, first))
    state[field] = {
      value: mixed ? null : first,
      mixed,
      overridden: rows.some((row) => row.overridden.has(field))
    }
  }
  return state
}
