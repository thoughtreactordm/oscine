import { artworkRef, type ArtworkRef } from '@shared/artwork'
import type { OverrideEditState, OverrideFieldState } from '@shared/overrides'

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
  readonly album: string | null
  readonly trackNo: number | null
  readonly discNo: number | null
  readonly year: number | null
  readonly genre: string | null
  /** SQLite booleans: 1 when the track carries an override for the field. */
  readonly ovTitle: number
  readonly ovArtist: number
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
