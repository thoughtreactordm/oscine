/**
 * The rows a drag is carrying, held beside the drag rather than inside it.
 *
 * `DataTransfer` would be the obvious home and cannot be used for this. Its
 * payload has to be written synchronously inside `dragstart`, and the thing
 * being dragged here is *a selection*, which is a set of ids with no order until
 * main puts one on it — a round trip. Fifty thousand rows would also be a
 * megabyte of string on the clipboard for a gesture that never leaves the app.
 *
 * So the transfer carries a token — Chromium cancels a drag whose transfer is
 * completely empty — and this module carries the cargo. A drag that started
 * anywhere else leaves `activeRowDrag()` null, which is what makes a file
 * dragged in from a file manager visibly not ours rather than something a drop
 * target has to sniff a mime type to reject.
 *
 * Module-level because a drag is singular — there is exactly one gesture in
 * flight in a window, and threading it through the components that happen to sit
 * between the list it started in and the pane it ends over would be plumbing for
 * a fact the platform already treats as global.
 */

export interface RowDragPayload {
  /** How many rows are moving, for the drop affordance. */
  readonly count: number
  /**
   * The playlist the rows were picked up from, or `null` when they came from
   * the library. A drop back into the same playlist is a reorder; anything else
   * is an add.
   */
  readonly playlistId: number | null
  /**
   * The dragged rows as track ids, in the order they were shown, or `null` when
   * the drag cannot offer them. A playlist drag is the `null` case: turning its
   * entry ids back into track ids is a lookup the contract has no single-call
   * verb for, and a target that needs them refuses the drop rather than fanning
   * out into one request per row.
   */
  readonly trackIds: (() => Promise<readonly number[]>) | null
  /**
   * The same rows as `playlist_entries` ids, or `null` when the drag did not
   * start in a playlist. D12: only the entry id can tell two copies of one track
   * apart, so a reorder cannot be expressed in track ids.
   */
  readonly entryIds: (() => Promise<readonly number[]>) | null
}

let active: RowDragPayload | null = null

export function beginRowDrag(payload: RowDragPayload): void {
  active = payload
}

/** What is being dragged, or `null` when the drag did not start in this window. */
export function activeRowDrag(): RowDragPayload | null {
  return active
}

export function endRowDrag(): void {
  active = null
}

/**
 * Resolves a promise once and hands the same one back afterwards.
 *
 * A drag fires `dragover` continuously and a drop can be preceded by dozens of
 * them; the selection behind it must be resolved once, not once per frame, and
 * not at `dragstart` either — a drag abandoned over nothing should cost nothing.
 */
export function lazily<T>(resolve: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= resolve())
}
