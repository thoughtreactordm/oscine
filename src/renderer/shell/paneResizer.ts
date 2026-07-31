/**
 * The arithmetic behind a draggable pane edge.
 *
 * Split from the component for the reason `trackWindow` is split from
 * `TrackList`: the part that can be wrong is the part that turns a pointer
 * position into a size, and the edges are exactly where it goes wrong — a drag
 * dragged past the container, a window too narrow for a pane's minimum and its
 * neighbour's both, a keyboard nudge already at the ceiling. All of that is
 * testable without a DOM. What is left in `PaneResizer.vue` is pointer
 * plumbing.
 *
 * No `@renderer` alias and no DOM type in this file on purpose: `tests/`
 * compiles under `tsconfig.node.json`, which maps neither.
 */

/** Which dimension a handle changes. */
export type ResizeAxis = 'x' | 'y'

/**
 * Where the pane being sized sits relative to its handle.
 *
 * `before` is the sidebar, whose handle runs down its right edge, and the
 * Artists pane, whose handle runs along its bottom: dragging away from the pane
 * grows it. `after` is the mirror of that, and the sign of the delta is the
 * only thing that differs.
 */
export type ResizeSide = 'before' | 'after'

/**
 * A resizable region, named once.
 *
 * The handle and the pane it sizes are two elements that have to agree about
 * the bounds, the axis and the storage key; a spec is what stops them being two
 * places to change. Every field is something either the arithmetic or the
 * handle's ARIA needs.
 */
export interface PaneSpec {
  /**
   * Storage key, namespaced by owner.
   *
   * The persisted layout is one flat record of these, so a pane belonging to a
   * panel says so — `sources.artists`, not `artists`.
   */
  readonly key: string
  readonly axis: ResizeAxis
  readonly side: ResizeSide
  /** Accessible name for the handle: "Sidebar width", "Artists pane height". */
  readonly label: string
  readonly defaultSize: number
  readonly min: number
  /** A ceiling independent of the container. Absent means the container decides. */
  readonly max?: number
  /**
   * Pixels the rest of the container keeps, whatever the drag asks for.
   *
   * A CSS `min-width` on the neighbour does not stop a drag — it makes the
   * flex row overflow instead, which is worse than a pane that refuses to grow.
   * Stating the neighbour's minimum here is what lets the drag stop at it. The
   * sidebar's 480 is the body's `min-w-120`, and the window's own `minWidth` of
   * 940 is why that has to be enforced rather than assumed.
   */
  readonly reserve?: number
}

/**
 * The largest this pane may be right now.
 *
 * A container too small for both the pane's minimum and the reserve has to
 * break one of them. It breaks the reserve: a pane below its minimum is
 * unusable, and a neighbour a few pixels short of its own is merely tight.
 */
export function paneCeiling(spec: PaneSpec, containerPx?: number): number {
  const hard = spec.max ?? Number.POSITIVE_INFINITY
  const room =
    containerPx === undefined || !Number.isFinite(containerPx)
      ? Number.POSITIVE_INFINITY
      : containerPx - (spec.reserve ?? 0)
  return Math.max(spec.min, Math.min(hard, room))
}

/**
 * A size held inside the pane's bounds, rounded to whole pixels.
 *
 * Whole pixels because the value is written to a `width` and read back out of
 * `getBoundingClientRect`, and a stored 320.4 that measures 320 is a pane that
 * shifts by a fraction every time it is dragged.
 *
 * A size that cannot be made finite — `NaN` from a corrupted stored layout, or
 * an unbounded `Infinity` from the End key before anything has been measured —
 * falls back to the default rather than propagating.
 */
export function clampPaneSize(spec: PaneSpec, size: number, containerPx?: number): number {
  const clamped = Math.min(paneCeiling(spec, containerPx), Math.max(spec.min, size))
  return Number.isFinite(clamped) ? Math.round(clamped) : spec.defaultSize
}

export interface PaneDrag {
  /** The pane's size when the pointer went down. */
  readonly startSize: number
  /** The pointer's coordinate along the axis when it went down. */
  readonly startPosition: number
  /** The pointer's coordinate along the axis now. */
  readonly position: number
  /** The container's size along the axis, if it has been measured. */
  readonly containerPx?: number
}

/**
 * Where a drag has got to.
 *
 * Measured from where the pointer went down rather than from the last event, so
 * a drag that runs past the ceiling and comes back lands where the pointer is
 * instead of where the accumulated deltas say. Every clamped pixel would
 * otherwise be lost from the total and the pane would drift away from the
 * cursor.
 */
export function draggedPaneSize(spec: PaneSpec, drag: PaneDrag): number {
  const delta = drag.position - drag.startPosition
  const size = drag.startSize + (spec.side === 'before' ? delta : -delta)
  return clampPaneSize(spec, size, drag.containerPx)
}

/** A keyboard step, clamped the same way a drag is. */
export function nudgedPaneSize(
  spec: PaneSpec,
  size: number,
  delta: number,
  containerPx?: number
): number {
  return clampPaneSize(spec, size + delta, containerPx)
}
