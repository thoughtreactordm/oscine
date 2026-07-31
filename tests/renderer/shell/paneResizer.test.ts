import { describe, expect, it } from 'vitest'
import {
  clampPaneSize,
  draggedPaneSize,
  nudgedPaneSize,
  paneCeiling,
  type PaneSpec
} from '../../../src/renderer/shell/paneResizer'

/** The frame's sidebar: bounded on both sides, and reserving the body's minimum. */
const sidebar: PaneSpec = {
  key: 'shell.sidebar',
  axis: 'x',
  side: 'before',
  label: 'Sidebar width',
  defaultSize: 320,
  min: 240,
  max: 480,
  reserve: 480
}

/** A pane with no ceiling of its own, the way the Artists split has none. */
const stacked: PaneSpec = {
  key: 'sources.artists',
  axis: 'y',
  side: 'before',
  label: 'Artists pane height',
  defaultSize: 280,
  min: 128,
  reserve: 176
}

/** The mirror case, which no pane uses yet and which the sign depends on. */
const trailing: PaneSpec = { ...stacked, key: 'trailing', side: 'after' }

describe('the ceiling a pane may be dragged to', () => {
  it('is the pane s own maximum when the container is roomy', () => {
    expect(paneCeiling(sidebar, 1600)).toBe(480)
  })

  it('is what the container leaves after the neighbour s reserve', () => {
    // The narrowest window the app allows is 940, and the body wants 480 of it.
    expect(paneCeiling(sidebar, 940)).toBe(460)
  })

  it('is unbounded for a pane with neither a maximum nor a measurement', () => {
    expect(paneCeiling(stacked)).toBe(Number.POSITIVE_INFINITY)
  })

  it('breaks the reserve rather than the minimum when the container cannot hold both', () => {
    // 300 of height, 176 reserved, leaves 124 — below the pane's own 128. A pane
    // under its minimum is unusable; a neighbour four pixels tight is not.
    expect(paneCeiling(stacked, 300)).toBe(128)
  })
})

describe('clamping a size', () => {
  it('holds it inside the bounds', () => {
    expect(clampPaneSize(sidebar, 100)).toBe(240)
    expect(clampPaneSize(sidebar, 9000)).toBe(480)
    expect(clampPaneSize(sidebar, 361)).toBe(361)
  })

  it('rounds to whole pixels, so a stored size measures back as itself', () => {
    expect(clampPaneSize(sidebar, 320.4)).toBe(320)
    expect(clampPaneSize(sidebar, 320.6)).toBe(321)
  })

  it('falls back to the default for a size that cannot be made finite', () => {
    expect(clampPaneSize(stacked, Number.NaN)).toBe(280)
    expect(clampPaneSize(stacked, Number.POSITIVE_INFINITY)).toBe(280)
  })

  it('resolves an unbounded request once the container has been measured', () => {
    expect(clampPaneSize(stacked, Number.POSITIVE_INFINITY, 800)).toBe(624)
  })
})

describe('dragging', () => {
  it('grows a leading pane when the pointer moves away from it', () => {
    const size = draggedPaneSize(sidebar, {
      startSize: 320,
      startPosition: 400,
      position: 460,
      containerPx: 1600
    })
    expect(size).toBe(380)
  })

  it('shrinks a leading pane when the pointer moves into it', () => {
    const size = draggedPaneSize(sidebar, {
      startSize: 320,
      startPosition: 400,
      position: 350,
      containerPx: 1600
    })
    expect(size).toBe(270)
  })

  it('reverses the sign for a pane that sits after its handle', () => {
    const grown = draggedPaneSize(trailing, {
      startSize: 280,
      startPosition: 400,
      position: 340,
      containerPx: 1600
    })
    expect(grown).toBe(340)
  })

  it('measures from where the pointer went down, so overshoot is not lost', () => {
    const drag = { startSize: 320, startPosition: 400, containerPx: 1600 }

    // Far past the 480 ceiling...
    expect(draggedPaneSize(sidebar, { ...drag, position: 1200 })).toBe(480)
    // ...and back. Accumulating clamped deltas would leave the pane pinned at
    // the ceiling here, drifting further from the cursor with every overshoot.
    expect(draggedPaneSize(sidebar, { ...drag, position: 420 })).toBe(340)
  })

  it('stops at what the container leaves rather than overflowing the row', () => {
    const size = draggedPaneSize(sidebar, {
      startSize: 320,
      startPosition: 400,
      position: 900,
      containerPx: 940
    })
    expect(size).toBe(460)
  })

  it('still clamps to the pane s own bounds before anything is measured', () => {
    const size = draggedPaneSize(sidebar, { startSize: 320, startPosition: 400, position: 40 })
    expect(size).toBe(240)
  })
})

describe('keyboard nudging', () => {
  it('steps and clamps like a drag', () => {
    expect(nudgedPaneSize(sidebar, 320, 16)).toBe(336)
    expect(nudgedPaneSize(sidebar, 248, -16)).toBe(240)
    expect(nudgedPaneSize(sidebar, 472, 16)).toBe(480)
  })

  it('does not move a pane already against its ceiling', () => {
    expect(nudgedPaneSize(sidebar, 480, 16)).toBe(480)
    expect(nudgedPaneSize(sidebar, 240, -16)).toBe(240)
  })
})
