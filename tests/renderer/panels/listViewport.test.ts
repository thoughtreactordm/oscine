import { describe, expect, it } from 'vitest'
import { visibleRange } from '../../../src/renderer/panels/listViewport'

/**
 * The up-next overlay's virtualization, which is arithmetic and nothing else.
 *
 * The property that matters is the one the standing invariant is about: the
 * number of rows drawn is bounded by the viewport, never by the list.
 */

describe('visible range', () => {
  it('draws a bounded number of rows however long the list is', () => {
    const short = visibleRange({ total: 20, rowPx: 36, viewportPx: 288, scrollTop: 0 })
    const long = visibleRange({ total: 100_000, rowPx: 36, viewportPx: 288, scrollTop: 0 })

    expect(long.last - long.first).toBe(short.last - short.first)
    expect(long.last - long.first + 1).toBeLessThan(30)
  })

  it('reserves the height of the rows it is not drawing', () => {
    const window = visibleRange({
      total: 1_000,
      rowPx: 36,
      viewportPx: 288,
      scrollTop: 3_600,
      overscan: 2
    })

    // Everything the scrollbar has to account for is one of three things: the
    // spacer above, the rows drawn, or the spacer below.
    const drawn = (window.last - window.first + 1) * 36
    expect(window.topPx + drawn + window.bottomPx).toBe(1_000 * 36)
  })

  it('overscans past both edges so a fast scroll does not show blanks', () => {
    const window = visibleRange({
      total: 1_000,
      rowPx: 36,
      viewportPx: 360,
      scrollTop: 3_600,
      overscan: 4
    })

    expect(window.first).toBe(96)
    expect(window.last).toBeGreaterThanOrEqual(110)
  })

  it('clamps at both ends rather than running off them', () => {
    const before = visibleRange({ total: 10, rowPx: 36, viewportPx: 288, scrollTop: -500 })
    expect(before.first).toBe(0)
    expect(before.topPx).toBe(0)

    const past = visibleRange({ total: 10, rowPx: 36, viewportPx: 288, scrollTop: 99_999 })
    expect(past.last).toBe(9)
    expect(past.bottomPx).toBe(0)
  })

  it('draws nothing for an empty list', () => {
    expect(visibleRange({ total: 0, rowPx: 36, viewportPx: 288, scrollTop: 0 })).toEqual({
      first: 0,
      last: -1,
      topPx: 0,
      bottomPx: 0
    })
  })

  it('still draws something before the container has been measured', () => {
    // A popover measures after its first paint, so a zero height that drew
    // nothing would have nothing to trigger the measurement that fixes it.
    const window = visibleRange({ total: 50, rowPx: 36, viewportPx: 0, scrollTop: 0 })

    expect(window.first).toBe(0)
    expect(window.last).toBeGreaterThanOrEqual(0)
  })
})
