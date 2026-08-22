import { ref } from 'vue'

/**
 * Where a drag lands, for the lists that reorder by dragging.
 *
 * Its own module because the rail and anything else that splices by pointer
 * share the arithmetic. The rail writes `playlists.position` through the main
 * process; the same index math is what `playlists.moveOpen` and
 * `UpNextQueue.move` read. Both splice the dragged item out before splicing it
 * back in, so the index they need is the same index computed the same way.
 */

export type DropSide = 'before' | 'after'

/**
 * The insertion point, expressed the way every reorder verb here reads it.
 *
 * `PlaylistStore.reorder`, `playlists.moveOpen` and `UpNextQueue.move` all
 * splice the moved item out first, so `toIndex` is an index into the list
 * *without* it. Computing the insertion point in the visible list and handing
 * that over unadjusted is the off-by-one this function exists to stop: it only
 * bites when dragging towards the end, so it survives casual testing.
 *
 * `null` means the gesture is a no-op — dropped on itself, or dropped into the
 * gap it already occupies, which is what "after my previous neighbour" is.
 *
 * Takes indices rather than ids because the up-next pane already knows both —
 * its rows are built from the array this indexes — and `dragover` fires
 * continuously, so a variant that searched an id array per event would search a
 * few thousand session rows twice a frame for an answer the caller had.
 */
export function insertionIndex(from: number, target: number, side: DropSide): number | null {
  if (from === -1 || target === -1) return null

  const insertAt = side === 'before' ? target : target + 1
  const toIndex = insertAt - (from < insertAt ? 1 : 0)
  return toIndex === from ? null : toIndex
}

/** `insertionIndex` for a list the caller identifies by id rather than by position. */
export function destinationIndex(
  order: readonly number[],
  draggedId: number,
  targetId: number,
  side: DropSide
): number | null {
  return insertionIndex(order.indexOf(draggedId), order.indexOf(targetId), side)
}

/**
 * The drag half of a reorderable list of playlists, minus the DOM.
 *
 * Held here rather than written twice because the interesting part is the
 * refusal: `dragOver` returns false for a drag this list did not start, so a
 * track selection dragged in from elsewhere falls through to whatever is
 * listening for it instead of being swallowed by a reorder that will not happen.
 */
export function createReorderDrag(
  order: () => readonly number[],
  move: (playlistId: number, toIndex: number) => void | Promise<void>,
  onBegin?: () => void
) {
  const dragId = ref<number | null>(null)
  const dropTargetId = ref<number | null>(null)
  const dropSide = ref<DropSide | null>(null)

  function begin(playlistId: number): void {
    onBegin?.()
    dragId.value = playlistId
    dropTargetId.value = null
    dropSide.value = null
  }

  /**
   * Tracks the drop point, and reports whether this list is claiming the drag.
   *
   * The indicator is set only where a real move would happen, so hovering the
   * gap an item already occupies shows nothing rather than promising a change
   * that will not come.
   */
  function over(overId: number, overSide: DropSide): boolean {
    if (dragId.value === null) return false
    if (destinationIndex(order(), dragId.value, overId, overSide) === null) {
      dropTargetId.value = null
      dropSide.value = null
      return true
    }
    dropTargetId.value = overId
    dropSide.value = overSide
    return true
  }

  /** `'before' | 'after' | null` for one row, so the component draws exactly one edge. */
  function indicator(playlistId: number): DropSide | null {
    return dropTargetId.value === playlistId ? dropSide.value : null
  }

  function end(): void {
    dragId.value = null
    dropTargetId.value = null
    dropSide.value = null
  }

  async function drop(): Promise<void> {
    const moved = dragId.value
    const onto = dropTargetId.value
    const ontoSide = dropSide.value
    const sequence = order()
    end()
    if (moved === null || onto === null || ontoSide === null) return

    const toIndex = destinationIndex(sequence, moved, onto, ontoSide)
    if (toIndex === null) return
    await move(moved, toIndex)
  }

  return { dragId, begin, over, indicator, end, drop }
}
