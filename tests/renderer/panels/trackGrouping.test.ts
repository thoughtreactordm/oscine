import { describe, expect, it } from 'vitest'
import type { TrackGroup } from '@shared/library'
import {
  groupedLayout,
  identityLayout,
  type GroupLayout
} from '../../../src/renderer/panels/trackGrouping'

function group(title: string, trackCount: number, albumId: number | null = 1): TrackGroup {
  return {
    albumId,
    title,
    albumArtist: null,
    year: null,
    trackCount,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' }
  }
}

/**
 * Walks a layout the way the list does, and checks it against the arithmetic
 * spelled out the long way. Binary searches are exactly the sort of code that
 * is right in the middle and wrong at both ends.
 */
function expectRoundTrip(layout: GroupLayout): void {
  const seen: number[] = []
  for (let display = 0; display < layout.displayCount; display++) {
    const row = layout.rowAt(display)
    expect(row).toBeDefined()
    if (row?.kind !== 'track') continue
    seen.push(row.offset)
    // Every track knows where it is drawn, and that position resolves back.
    expect(layout.displayOf(row.offset)).toBe(display)
  }
  // Each track appears once, in order, with no gaps.
  expect(seen).toEqual(Array.from({ length: layout.trackCount }, (_, index) => index))
}

describe('identityLayout', () => {
  it('is the ungrouped list, one display row per track', () => {
    const layout = identityLayout(2_500)
    expect(layout.displayCount).toBe(2_500)
    expect(layout.trackCount).toBe(2_500)
    expect(layout.runs).toEqual([])
    expect(layout.rowAt(0)).toEqual({ kind: 'track', offset: 0 })
    expect(layout.rowAt(2_499)).toEqual({ kind: 'track', offset: 2_499 })
    expect(layout.rowAt(2_500)).toBeUndefined()
    expect(layout.rowAt(-1)).toBeUndefined()
  })

  it('has nothing to draw for an empty list', () => {
    const layout = identityLayout(0)
    expect(layout.displayCount).toBe(0)
    expect(layout.rowAt(0)).toBeUndefined()
  })
})

describe('groupedLayout', () => {
  const groups = [group('First', 3, 1), group('Second', 1, 2), group('Third', 2, 3)]

  it('inserts one header per run and offsets everything after it', () => {
    const layout = groupedLayout(groups)

    // 6 tracks + 3 headers.
    expect(layout.displayCount).toBe(9)
    expect(layout.trackCount).toBe(6)
    expect(layout.runs.map((run) => run.headerIndex)).toEqual([0, 4, 6])
    expect(layout.runs.map((run) => run.firstOffset)).toEqual([0, 3, 4])

    expect(layout.rowAt(0)).toMatchObject({ kind: 'header' })
    expect(layout.rowAt(1)).toEqual({ kind: 'track', offset: 0 })
    expect(layout.rowAt(3)).toEqual({ kind: 'track', offset: 2 })
    expect(layout.rowAt(4)).toMatchObject({ kind: 'header' })
    expect(layout.rowAt(5)).toEqual({ kind: 'track', offset: 3 })
    expect(layout.rowAt(6)).toMatchObject({ kind: 'header' })
    expect(layout.rowAt(8)).toEqual({ kind: 'track', offset: 5 })
    expect(layout.rowAt(9)).toBeUndefined()
  })

  it('names the album each header heads', () => {
    const layout = groupedLayout(groups)
    const headers = [0, 4, 6].map((display) => layout.rowAt(display))
    expect(headers.map((row) => (row?.kind === 'header' ? row.run.group.title : null))).toEqual([
      'First',
      'Second',
      'Third'
    ])
  })

  it('round-trips every position, both directions', () => {
    expectRoundTrip(groupedLayout(groups))
  })

  /**
   * The shape that actually ships: a few hundred albums of wildly uneven
   * length. An off-by-one in the search shows up here and nowhere in the
   * three-album case above.
   */
  it('round-trips a realistic discography', () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      group(`Album ${index}`, (index % 17) + 1, index + 1)
    )
    const layout = groupedLayout(many)
    expect(layout.runs).toHaveLength(400)
    expectRoundTrip(layout)
  })

  /**
   * Scrolling focus into view multiplies out to pixels, so this has to be exact
   * at the row *after* a header as well as at the header itself.
   */
  it('counts the headers above a display position', () => {
    const layout = groupedLayout(groups)
    // Headers sit at display 0, 4 and 6.
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => layout.headersBefore(d))).toEqual([
      0, 1, 1, 1, 1, 2, 2, 3, 3, 3
    ])
    expect(layout.headersBefore(-5)).toBe(0)
    expect(layout.headersBefore(999)).toBe(3)
    expect(identityLayout(100).headersBefore(50)).toBe(0)
  })

  it('places every row at the pixel the virtualizer would', () => {
    const rowHeight = 32
    const headerHeight = 56
    const layout = groupedLayout(groups)

    // Walk the list summing real heights, and check the closed form agrees.
    let top = 0
    for (let display = 0; display < layout.displayCount; display++) {
      const headers = layout.headersBefore(display)
      expect(headers * headerHeight + (display - headers) * rowHeight).toBe(top)
      top += layout.rowAt(display)?.kind === 'header' ? headerHeight : rowHeight
    }
  })

  it('drops a run with no tracks rather than heading nothing', () => {
    const layout = groupedLayout([group('Real', 2, 1), group('Empty', 0, 2), group('Also', 1, 3)])
    expect(layout.runs.map((run) => run.group.title)).toEqual(['Real', 'Also'])
    expect(layout.trackCount).toBe(3)
    expectRoundTrip(layout)
  })

  it('has nothing to draw for a library with no albums', () => {
    const layout = groupedLayout([])
    expect(layout.displayCount).toBe(0)
    expect(layout.trackCount).toBe(0)
    expect(layout.rowAt(0)).toBeUndefined()
  })

  it('keeps the untagged run, which carries no album at all', () => {
    const layout = groupedLayout([group('Tagged', 2, 1), group(null as never, 3, null)])
    expect(layout.runs).toHaveLength(2)
    expect(layout.runs[1]!.group.albumId).toBeNull()
    expectRoundTrip(layout)
  })
})
