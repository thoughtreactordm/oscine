/**
 * Which rows of a fixed-height list are on screen, and how much space the rest
 * of them take up.
 *
 * The standing invariant has no exception for popovers: the up-next overlay can
 * hold a thousand rows as easily as three, and a popover that renders all of
 * them is the same mistake as a track list that does. It does not need
 * `trackWindow`, though — the queue is already in memory, so there are no pages
 * to fetch, nothing to evict and no ordering generation. What is left is
 * arithmetic, which is exactly the part worth having on its own and testing
 * without a browser.
 *
 * Two spacers rather than absolute positioning: a padded scroll container keeps
 * the rows in normal flow, so they can be focusable list items and the
 * scrollbar is the real one.
 */

export interface ListViewport {
  /** First row to render, inclusive. */
  readonly first: number
  /** Last row to render, inclusive. `first - 1` when there is nothing to draw. */
  readonly last: number
  /** Pixels of empty space standing in for the rows above `first`. */
  readonly topPx: number
  /** Pixels standing in for the rows below `last`. */
  readonly bottomPx: number
}

export interface ListViewportInput {
  /** Rows in the list. */
  total: number
  /** Height of one row, in pixels. */
  rowPx: number
  /** Height of the scroll container, in pixels. */
  viewportPx: number
  scrollTop: number
  /** Rows drawn beyond each edge, so a fast scroll does not show blanks. */
  overscan?: number
}

export function visibleRange(input: ListViewportInput): ListViewport {
  const { total } = input
  const rowPx = Math.max(1, input.rowPx)
  const overscan = Math.max(0, input.overscan ?? 4)

  if (total <= 0) return { first: 0, last: -1, topPx: 0, bottomPx: 0 }

  // A container that has not been measured yet reports zero height. Drawing
  // nothing would be correct and would also never correct itself, because a
  // popover measures after its first paint — so an unmeasured viewport draws
  // the overscan and lets the measurement widen it.
  const viewportPx = Math.max(rowPx, input.viewportPx)
  const scrollTop = Math.min(Math.max(0, input.scrollTop), Math.max(0, total * rowPx - viewportPx))

  const first = Math.max(0, Math.floor(scrollTop / rowPx) - overscan)
  const visible = Math.ceil(viewportPx / rowPx)
  const last = Math.min(total - 1, first + visible + overscan * 2)

  return {
    first,
    last,
    topPx: first * rowPx,
    bottomPx: Math.max(0, (total - 1 - last) * rowPx)
  }
}
