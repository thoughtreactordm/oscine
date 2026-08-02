import { ref } from 'vue'
import { insertionIndex, type DropSide } from '../playlistReorder'
import type { QueueEntry, QueueOrigin } from '../../playback/upNextQueue'

/**
 * What the up-next pane draws, and where a drag inside it lands.
 *
 * Relative imports and no DOM type, for the reason stated at the top of
 * `tunedeckPanes.ts`: `tests/` compiles under `tsconfig.node.json`, which maps
 * neither `@renderer` nor a DOM lib, and this is exactly the part worth testing
 * without a browser. The component above it owns the pixels and nothing else.
 *
 * ## One row list, two tiers
 *
 * The pane is one virtualized scroll container, so the tier labels are rows of
 * the same height as the entries rather than headings outside the list — two
 * virtualized containers in one pane would be two scroll positions to reconcile
 * and the session tier is the first queue that can genuinely be thousands of
 * rows. `visibleRange` therefore stays plain arithmetic over a single total.
 *
 * The rows are built from the queue's **global** order rather than from the two
 * tier projections, because `index` has to be an index into the array
 * `UpNextQueue.move` splices. Deriving it from a per-tier list would mean adding
 * the boundary back on at the call site, and getting that wrong moves a session
 * row to the top of the session tier instead of where it was dropped — which
 * looks like a working drag until you try the second tier.
 */

/** How each tier names itself, in one place, so both hosts of the pane agree. */
export const TIER_LABEL: Readonly<Record<QueueOrigin, string>> = {
  user: 'Queued by you',
  session: 'Continuing'
}

export type UpNextRow =
  | {
      readonly kind: 'header'
      readonly key: string
      readonly origin: QueueOrigin
      readonly label: string
      readonly count: number
      /**
       * The first entry of the tier this labels.
       *
       * A label is a row, so it is 36 pixels a drag can be over, and "just above
       * the first row of this tier" is exactly where a hand aims to put
       * something at the top of one. Without this the label is a band where
       * nothing happens, which is the same defect as a gap between rows and
       * reads the same way — as a drop that did not work.
       */
      readonly firstId: string
    }
  | {
      readonly kind: 'entry'
      readonly key: string
      readonly entry: QueueEntry
      /** Index into the queue as a whole — what `move` and `visibleRange` count in. */
      readonly index: number
      /** 1-based within its own tier: "3 of the ones I queued" is what is being counted. */
      readonly position: number
      /** §5 rule 1's first arm, made visible: the head is what plays next. */
      readonly isNext: boolean
    }

/**
 * The queue as rows, with a label wherever the tier changes.
 *
 * Written as "on change of origin" rather than "user rows, then session rows"
 * so it describes the array it was handed instead of restating the invariant
 * that array is supposed to hold. If the tiers ever interleaved, this would say
 * so on screen rather than mislabel them.
 */
export function buildUpNextRows(entries: readonly QueueEntry[]): UpNextRow[] {
  const rows: UpNextRow[] = []
  let origin: QueueOrigin | null = null
  let position = 0

  entries.forEach((entry, index) => {
    if (entry.origin !== origin) {
      origin = entry.origin
      position = 0
      rows.push({
        kind: 'header',
        key: `h:${index}:${origin}`,
        origin,
        label: TIER_LABEL[origin],
        count: countFrom(entries, index),
        firstId: entry.id
      })
    }
    position += 1
    rows.push({
      kind: 'entry',
      key: entry.id,
      entry,
      index,
      position,
      isNext: index === 0
    })
  })

  return rows
}

/** How many consecutive entries from `at` share its tier. */
function countFrom(entries: readonly QueueEntry[], at: number): number {
  const origin = entries[at]?.origin
  let count = 0
  for (let index = at; index < entries.length && entries[index]?.origin === origin; index++) {
    count += 1
  }
  return count
}

/**
 * Where a drop lands, or `null` when the gesture changes nothing.
 *
 * **Tier-local, and refused rather than clamped.** `UpNextQueue.move` clamps a
 * move to the mover's own tier, so a drop drawn across the boundary would land
 * somewhere other than where the indicator promised — a hand-queued row dropped
 * into the middle of a three-hundred-row scope would quietly go back to the
 * bottom of the user tier. A drop that visibly refuses is the honest one, and it
 * is also what the boundary means: the user tier sits above the session tier
 * because §5 says it does, not because of where anything was dragged.
 */
export function queueDestination(
  entries: readonly QueueEntry[],
  draggedId: string,
  targetId: string,
  side: DropSide
): number | null {
  const from = entries.findIndex((entry) => entry.id === draggedId)
  const target = entries.findIndex((entry) => entry.id === targetId)
  if (from === -1 || target === -1) return null
  if (entries[from]?.origin !== entries[target]?.origin) return null
  return insertionIndex(from, target, side)
}

/**
 * The drag half of the pane, minus the DOM.
 *
 * Not `createReorderDrag`: that one is keyed by playlist id and, more to the
 * point, has no notion of a boundary a drag may not cross. The refusal is the
 * substance here, and the arithmetic the two do share is `insertionIndex`,
 * which they both call.
 */
export function createQueueReorder(
  entries: () => readonly QueueEntry[],
  move: (entryId: string, toIndex: number) => unknown
) {
  const dragId = ref<string | null>(null)
  const dropTargetId = ref<string | null>(null)
  const dropSide = ref<DropSide | null>(null)

  function clear(): void {
    dragId.value = null
    dropTargetId.value = null
    dropSide.value = null
  }

  function begin(entryId: string): void {
    clear()
    dragId.value = entryId
  }

  /**
   * Tracks the drop point, and reports whether this list is claiming the drag.
   *
   * False for a drag this pane did not start, so a track selection dragged in
   * from the library falls through to whatever is listening for it rather than
   * being swallowed by a reorder that will not happen.
   */
  function over(overId: string, side: DropSide): boolean {
    if (dragId.value === null) return false
    if (queueDestination(entries(), dragId.value, overId, side) === null) {
      dropTargetId.value = null
      dropSide.value = null
      return true
    }
    dropTargetId.value = overId
    dropSide.value = side
    return true
  }

  /** `'before' | 'after' | null` for one row, so the component draws exactly one edge. */
  function indicator(entryId: string): DropSide | null {
    return dropTargetId.value === entryId ? dropSide.value : null
  }

  function drop(): void {
    const moved = dragId.value
    const onto = dropTargetId.value
    const side = dropSide.value
    const current = entries()
    clear()
    if (moved === null || onto === null || side === null) return

    const toIndex = queueDestination(current, moved, onto, side)
    if (toIndex === null) return
    move(moved, toIndex)
  }

  return { dragId, begin, over, indicator, end: clear, drop }
}
