import type { TrackGroup } from '@shared/library'

/**
 * The album-header layer over a virtualized track list.
 *
 * A grouped list draws one header row per album run, so the position the
 * virtualizer indexes is no longer the offset the library pages against. Every
 * conversion between the two lives here, as arithmetic over the run lengths,
 * for the same reason `nextFocusIndex` does: it is wrong only at boundaries,
 * and a boundary error thousands of rows down is invisible until someone
 * scrolls there.
 *
 * Nothing else has to learn about headers. Selection, the range anchor and
 * keyboard focus all address tracks by offset and keep doing so — a header is
 * not a track, so it cannot be selected, and skipping one costs nothing because
 * arrow keys were never walking display rows in the first place.
 */

export interface GroupedRun {
  group: TrackGroup
  /** Display position of this run's header row. */
  headerIndex: number
  /** Offset of this run's first track, in the ungrouped list. */
  firstOffset: number
}

export type GroupedRow = { kind: 'header'; run: GroupedRun } | { kind: 'track'; offset: number }

export interface GroupLayout {
  readonly runs: readonly GroupedRun[]
  /** Rows the virtualizer draws: every track, plus one header per run. */
  readonly displayCount: number
  /** Tracks described. Compared against the panel's own total before use. */
  readonly trackCount: number
  rowAt(display: number): GroupedRow | undefined
  /** Where a track offset sits on screen — for scrolling focus into view. */
  displayOf(offset: number): number
  /**
   * Header rows strictly before a display position.
   *
   * Scrolling a row into view is pixel arithmetic, and headers are taller than
   * tracks, so `display * rowHeight` stops being true the moment one exists.
   */
  headersBefore(display: number): number
}

/** What the two kinds of row are drawn at, in CSS pixels. */
export interface RowMetrics {
  /** A track row — `view.trackListDensity`. */
  rowPx: number
  /** An album header row — `view.trackGroupingArtSize`. */
  headerPx: number
}

/**
 * Where a display row's top edge sits, in pixels from the top of the list.
 *
 * The arithmetic `headersBefore` exists for, named once instead of spelled out
 * at each call site. Clamped rather than guarded, so asking about a row past the
 * end gives the end of the list — which is what a scroll target wants.
 */
export function displayTopPx(layout: GroupLayout, display: number, metrics: RowMetrics): number {
  const clamped = Math.max(0, Math.min(display, layout.displayCount))
  const headers = layout.headersBefore(clamped)
  return headers * metrics.headerPx + (clamped - headers) * metrics.rowPx
}

/**
 * `displayTopPx` run backwards: the display row a pixel offset lands in.
 *
 * Binary search rather than a division, because two row heights make the offset
 * piecewise linear and `scrollTop / rowHeight` is wrong from the first album
 * boundary down — the same reason `scrollIndexIntoView` never multiplied. It is
 * monotonic in `display`, which is what makes the search legitimate, and it is
 * seventeen steps at the 100k target.
 *
 * What needs it: changing the row height changes what a *pixel* offset means, so
 * a density change converts the offset to a row before and back to pixels after.
 * Keeping the top row still is the only reading of "where I was" that survives
 * the rows changing size.
 */
export function displayAtPx(layout: GroupLayout, top: number, metrics: RowMetrics): number {
  let low = 0
  let high = Math.max(0, layout.displayCount - 1)
  let found = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (displayTopPx(layout, mid, metrics) <= top) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * The ungrouped list, as a layout.
 *
 * Lets the list render through one path whether or not it is grouped, rather
 * than branching every lookup on a boolean — the branch is where the two would
 * drift apart.
 */
export function identityLayout(total: number): GroupLayout {
  const count = Math.max(0, total)
  return {
    runs: [],
    displayCount: count,
    trackCount: count,
    rowAt: (display) =>
      display >= 0 && display < count ? { kind: 'track', offset: display } : undefined,
    displayOf: (offset) => offset,
    headersBefore: () => 0
  }
}

export function groupedLayout(groups: readonly TrackGroup[]): GroupLayout {
  const runs: GroupedRun[] = []
  let offset = 0
  let display = 0
  for (const group of groups) {
    // A run with no tracks would give a header nothing to head, and would break
    // the assumption below that a header is always followed by its first track.
    if (group.trackCount <= 0) continue
    runs.push({ group, headerIndex: display, firstOffset: offset })
    offset += group.trackCount
    display += group.trackCount + 1
  }

  const trackCount = offset
  const displayCount = display

  /** Index of the last run starting at or before a display position, or -1. */
  function runIndexAtDisplay(target: number): number {
    let low = 0
    let high = runs.length - 1
    let found = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (runs[mid]!.headerIndex <= target) {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }

  function runAtDisplay(target: number): GroupedRun | undefined {
    if (target < 0 || target >= displayCount) return undefined
    const index = runIndexAtDisplay(target)
    return index < 0 ? undefined : runs[index]
  }

  /** The last run beginning at or before a track offset. */
  function runAtOffset(target: number): GroupedRun | undefined {
    if (target < 0 || target >= trackCount) return undefined
    let low = 0
    let high = runs.length - 1
    let found: GroupedRun | undefined
    while (low <= high) {
      const mid = (low + high) >> 1
      const run = runs[mid]!
      if (run.firstOffset <= target) {
        found = run
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }

  function rowAt(display: number): GroupedRow | undefined {
    const run = runAtDisplay(display)
    if (!run) return undefined
    if (run.headerIndex === display) return { kind: 'header', run }
    return { kind: 'track', offset: run.firstOffset + (display - run.headerIndex - 1) }
  }

  function displayOf(offset: number): number {
    const run = runAtOffset(offset)
    if (!run) return 0
    return run.headerIndex + 1 + (offset - run.firstOffset)
  }

  return {
    runs,
    displayCount,
    trackCount,
    rowAt,
    displayOf,
    headersBefore(display) {
      if (display <= 0) return 0
      if (display >= displayCount) return runs.length
      // The run starting at or before `display - 1`; every earlier run's header
      // is behind us, and so is this one's.
      return runIndexAtDisplay(display - 1) + 1
    }
  }
}
