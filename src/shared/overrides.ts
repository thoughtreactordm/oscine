/**
 * The track-metadata edit surface — **W16 (editor)**, design authority D7/D28.
 *
 * D7 keeps corrections in `track_overrides` and never on disk; D28 flushes them
 * on demand. This is the front half: the operator edits a track (or a batch), the
 * correction is recorded in `track_overrides` *and* materialised into the live
 * display rows so it shows at once — in every track list, the facets, the sort,
 * and the write-back review — while the files stay untouched until an explicit
 * flush. `src/shared` because the editor (renderer), the write (main) and the
 * review all speak the same field vocabulary.
 */

/** The fields a metadata edit can set. Genre is a single delimited string here. */
export type OverrideField = 'title' | 'artist' | 'album' | 'trackNo' | 'discNo' | 'year' | 'genre'

/** Every editable field, in the order the editor lays them out. */
export const OVERRIDE_FIELDS: readonly OverrideField[] = [
  'title',
  'artist',
  'album',
  'trackNo',
  'discNo',
  'year',
  'genre'
]

/** The most tracks one edit may target — a batch is bounded like every id set. */
export const MAX_OVERRIDE_TRACKS = 50_000

/**
 * One edit's changes.
 *
 * A field **present** is set to its value; a **string** value of `''` clears the
 * tag — a deliberate "this file has no title" — while a field **absent** from the
 * patch is left exactly as it was, which is what makes a batch edit touch only
 * the fields the operator actually changed. Numbers carry a value to set;
 * emptying a number, and reverting any field to what the file holds, is the
 * separate `clear` path, not a value here.
 */
export interface OverridePatch {
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly trackNo?: number
  readonly discNo?: number
  readonly year?: number
  readonly genre?: string
}

/**
 * One field's state across the edited batch, for the editor's prefill.
 *
 * `value` is the shared current value when every selected track agrees, else
 * `null` with `mixed` set — the editor shows a "multiple values" placeholder and
 * only writes the field if the operator types over it. `overridden` is true when
 * at least one selected track already carries a correction for the field, so the
 * editor can offer to revert it.
 */
export interface OverrideFieldState<T> {
  readonly value: T | null
  readonly mixed: boolean
  readonly overridden: boolean
}

/** The whole edit form's prefill for a set of tracks. */
export interface OverrideEditState {
  readonly trackCount: number
  readonly title: OverrideFieldState<string>
  readonly artist: OverrideFieldState<string>
  readonly album: OverrideFieldState<string>
  readonly trackNo: OverrideFieldState<number>
  readonly discNo: OverrideFieldState<number>
  readonly year: OverrideFieldState<number>
  readonly genre: OverrideFieldState<string>
}
