import { computed, ref, type Ref } from 'vue'

/**
 * Arbitrary multi-selection over a virtualized list.
 *
 * The selection is a set of track ids and never a set of rows. That is the
 * whole design: a row is a transient thing this panel borrows from main and
 * gives back, so a selection made of rows would be destroyed by the page cache
 * doing its job, and a selection made of positions would be destroyed by a
 * re-sort. Ids survive both, and they are also what M4 needs to hand a playlist.
 *
 * The cost of that choice is that a set of ids has no order and no positions.
 * Order is recovered on demand from main (`resolveSelection`), and positions are
 * only ever needed for two rows — the focus and the anchor — each of which is
 * carried as an id/index pair and re-adopted when its page happens to arrive.
 *
 * Kept free of Vue components, IPC and the store so the semantics below can be
 * driven against a synthetic 100k-row source in a plain unit test.
 */

/**
 * What a click or keypress means.
 *
 * - `replace` — the plain case: this row becomes the selection and the anchor.
 * - `toggle` — Ctrl: flip this row, leave the rest of a disjoint set alone.
 * - `range` — Shift: the inclusive span from the anchor becomes the selection.
 * - `extend` — Ctrl+Shift: add that span, keeping everything already selected.
 */
export type SelectionIntent = 'replace' | 'toggle' | 'range' | 'extend'

/** Just the modifier flags, so callers can pass a real event or a literal. */
export interface SelectionModifiers {
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
}

/**
 * `metaKey` counts as `ctrlKey`. Fermata targets Windows and Linux, where the
 * distinction does not arise, and accepting both costs one comparison rather
 * than a platform branch this file would otherwise have to grow later.
 */
export function selectionIntent(modifiers: SelectionModifiers): SelectionIntent {
  const toggling = modifiers.ctrlKey === true || modifiers.metaKey === true
  if (modifiers.shiftKey === true) return toggling ? 'extend' : 'range'
  return toggling ? 'toggle' : 'replace'
}

/** A row as this module needs to see it: an id at a position. */
interface IdentifiedRow {
  readonly id: number
}

export interface TrackSelectionDeps {
  /** Track id at a loaded row, or `undefined` when its page is not held. */
  idAt: (index: number) => number | undefined
  /**
   * Ids for an inclusive index range under the current ordering, in list order.
   * Must not load or retain rows — that is the point of it existing.
   */
  fetchIdRange: (first: number, last: number) => Promise<number[]>
  /** Orders an arbitrary id set the way the list would. */
  orderIds: (ids: readonly number[]) => Promise<number[]>
  /** Ordering generation. A change invalidates every index in flight. */
  ordering: () => number
  /** Row count under the current ordering. */
  total: () => number
}

export function createTrackSelection(deps: TrackSelectionDeps) {
  /**
   * Membership, and the only authoritative part of the selection.
   *
   * A reactive `Set` rather than a replaced-on-write one so a toggle wakes the
   * rows that actually changed. Replacing it would invalidate every `has` in
   * the viewport on every Ctrl+click.
   */
  const ids = ref(new Set<number>()) as Ref<Set<number>>

  /**
   * Where the keyboard is, and where a range is measured from.
   *
   * Two pairs, not two numbers: a re-sort moves rows without telling us where
   * they went, so each is an id that survives and an index that does not.
   * `invalidateIndices` drops the indices; `adoptPage` re-adopts them.
   */
  const focusIndex = ref<number | null>(null)
  const focusId = ref<number | null>(null)
  const anchorIndex = ref<number | null>(null)
  const anchorId = ref<number | null>(null)

  /** Non-zero while a range is being resolved from main, for a busy affordance. */
  const resolving = ref(0)

  const count = computed(() => ids.value.size)

  function isSelected(id: number | undefined): boolean {
    return id !== undefined && ids.value.has(id)
  }

  /** Membership by position, for a rendered row whose page is loaded. */
  function isSelectedAt(index: number): boolean {
    return isSelected(deps.idAt(index))
  }

  function setFocus(index: number | null): void {
    focusIndex.value = index
    focusId.value = index === null ? null : (deps.idAt(index) ?? null)
  }

  function setAnchor(index: number | null): void {
    anchorIndex.value = index
    anchorId.value = index === null ? null : (deps.idAt(index) ?? null)
  }

  /**
   * Ids for an inclusive index range, or `null` if the ordering changed while
   * they were being fetched.
   *
   * Loaded rows answer locally, which is what keeps Shift+ArrowDown from firing
   * a query per keypress. As soon as one row in the range is missing the whole
   * range goes to main as a single id query rather than being assembled from
   * pages — fetching pages would mean retaining them, and a range selection is
   * exactly the operation that must not grow the page cache.
   */
  async function idsInRange(first: number, last: number): Promise<number[] | null> {
    if (last < first) return []

    const local: number[] = []
    for (let index = first; index <= last; index++) {
      const id = deps.idAt(index)
      if (id === undefined) break
      local.push(id)
    }
    if (local.length === last - first + 1) return local

    const generation = deps.ordering()
    resolving.value++
    try {
      const fetched = await deps.fetchIdRange(first, last)
      return generation === deps.ordering() ? fetched : null
    } finally {
      resolving.value--
    }
  }

  function inBounds(index: number): boolean {
    if (!Number.isInteger(index) || index < 0) return false
    const total = deps.total()
    return total === 0 || index < total
  }

  /**
   * Applies a selection at `index`.
   *
   * Focus and anchor move synchronously so the caret never lags the input, even
   * when the rows behind a Shift-range still have to be fetched. The set itself
   * is updated in place, and only for the ids that changed.
   */
  async function apply(index: number, intent: SelectionIntent): Promise<void> {
    if (!inBounds(index)) return
    setFocus(index)

    if (intent === 'range' || intent === 'extend') {
      if (anchorIndex.value === null) setAnchor(index)
      const anchor = anchorIndex.value ?? index
      const range = await idsInRange(Math.min(anchor, index), Math.max(anchor, index))
      if (range === null) return
      // The anchor deliberately stays put. Successive Shift+clicks all measure
      // from the same row, which is what lets an overshot range be corrected
      // without starting the selection over.
      if (intent === 'range') ids.value.clear()
      for (const id of range) ids.value.add(id)
      return
    }

    const range = await idsInRange(index, index)
    const id = range?.[0]
    if (id === undefined) return
    setAnchor(index)
    // A row selected before its page arrived left the anchor without an id.
    if (anchorId.value === null) anchorId.value = id

    if (intent === 'toggle') {
      if (!ids.value.delete(id)) ids.value.add(id)
      return
    }
    ids.value.clear()
    ids.value.add(id)
  }

  /** Moves the keyboard focus without touching the selection or the anchor. */
  function moveFocusOnly(index: number): void {
    if (!inBounds(index)) return
    setFocus(index)
  }

  function clear(): void {
    ids.value.clear()
    setAnchor(null)
  }

  /**
   * Reconciles focus and anchor against a page that just landed.
   *
   * Runs in both directions: a re-sort leaves an id without an index, and
   * keyboard navigation onto an unloaded row leaves an index without an id.
   */
  function adoptPage(rows: readonly IdentifiedRow[], page: number, pageSize: number): void {
    adopt(focusIndex, focusId, rows, page, pageSize)
    adopt(anchorIndex, anchorId, rows, page, pageSize)
  }

  function adopt(
    index: Ref<number | null>,
    id: Ref<number | null>,
    rows: readonly IdentifiedRow[],
    page: number,
    pageSize: number
  ): void {
    if (index.value === null) {
      if (id.value === null) return
      const offset = rows.findIndex((row) => row.id === id.value)
      if (offset >= 0) index.value = page * pageSize + offset
      return
    }

    const offset = index.value - page * pageSize
    if (offset >= 0 && offset < rows.length) id.value = rows[offset]?.id ?? null
  }

  /**
   * Ordering changed: every index this module holds now describes the wrong row.
   * Membership is untouched — that is the contract a re-sort must not break.
   */
  function invalidateIndices(): void {
    focusIndex.value = null
    anchorIndex.value = null
  }

  /**
   * The selection as track ids in list order.
   *
   * Resolved in main because that is the only place the list order lives: a set
   * of ids has none, and keeping a position for every selected row would mean
   * re-deriving all of them on every re-sort, which is the cost this model
   * exists to avoid. Ids no longer in the library are dropped, so a consumer
   * adding tracks to a playlist never has to check.
   */
  async function resolveSelection(): Promise<number[]> {
    if (ids.value.size === 0) return []
    return deps.orderIds([...ids.value])
  }

  return {
    ids,
    count,
    focusIndex,
    focusId,
    anchorIndex,
    anchorId,
    resolving: computed(() => resolving.value > 0),
    isSelected,
    isSelectedAt,
    apply,
    moveFocusOnly,
    clear,
    adoptPage,
    invalidateIndices,
    resolveSelection
  }
}

export type TrackSelection = ReturnType<typeof createTrackSelection>
