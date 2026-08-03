import { describe, expect, it } from 'vitest'
import {
  bucketAtX,
  chartGeometry,
  type ChartInput
} from '../../../src/renderer/panels/listening/listeningChart'
import { STATS_BUCKET_MS, type StatsOverTimePoint } from '@shared/stats'

const START = new Date(2026, 6, 1).getTime()

function points(values: readonly number[]): StatsOverTimePoint[] {
  return values.map((listens, index) => ({
    startedAt: START + index * STATS_BUCKET_MS.day,
    listens,
    msListened: listens * 200_000
  }))
}

function geometry(values: readonly number[], over: Partial<ChartInput> = {}) {
  return chartGeometry({
    points: points(values),
    bucket: 'day',
    sort: 'listens',
    width: 800,
    height: 176,
    ...over
  })
}

describe('chartGeometry', () => {
  it('draws columns while a band can still hold a mark and its gap', () => {
    expect(geometry([1, 2, 3, 4, 5, 6, 7]).form).toBe('columns')
    expect(geometry(new Array(90).fill(3)).form).toBe('columns')
  })

  it('changes to an area once the bands are too narrow to resolve', () => {
    const dense = geometry(new Array(365).fill(3))
    expect(dense.form).toBe('area')
    expect(dense.columns).toHaveLength(0)
    expect(dense.linePath.startsWith('M')).toBe(true)
    expect(dense.areaPath.endsWith('Z')).toBe(true)
  })

  it('follows the width rather than the bucket count', () => {
    // The same thirty buckets: wide enough for columns in a full pane, an area
    // in a narrow one. The threshold is arithmetic, so it survives a resize.
    expect(geometry(new Array(30).fill(2), { width: 800 }).form).toBe('columns')
    expect(geometry(new Array(30).fill(2), { width: 200 }).form).toBe('area')
  })

  it('has nothing to draw with no points or no room', () => {
    expect(geometry([]).form).toBe('empty')
    expect(geometry([1, 2], { width: 20 }).form).toBe('empty')
    expect(geometry([1, 2], { height: 0 }).form).toBe('empty')
  })

  it('starts the axis at zero and finishes above the tallest column', () => {
    const chart = geometry([3, 17, 5])
    const values = chart.gridlines.map((line) => line.label)
    expect(values[0]).toBe('0')
    expect(chart.gridlines[0].y).toBe(chart.baseline)
    // The axis has to finish at or above the peak, or the tallest column is
    // drawn off the top of its own plot.
    expect(values[values.length - 1]).toBe('20')
    expect(chart.gridlines[chart.gridlines.length - 1].y).toBeCloseTo(chart.plot.y, 5)
    // And every mark lands inside it, peak included.
    for (const mark of chart.marks) {
      expect(mark.y).toBeGreaterThanOrEqual(chart.plot.y)
      expect(mark.y).toBeLessThanOrEqual(chart.baseline)
    }
  })

  it('grows a third interval rather than clipping a peak the second falls short of', () => {
    // 26 against a nice step of 10 needs three intervals; two would top out at
    // 20 and draw the tallest column past the top of the plot.
    const chart = geometry([26, 4])
    expect(chart.gridlines.map((line) => line.label)).toEqual(['0', '10', '20', '30'])
    expect(chart.marks[0].y).toBeGreaterThanOrEqual(chart.plot.y)
  })

  it('rounds axis labels to numbers a person would say', () => {
    expect(geometry([0, 7, 3]).gridlines.map((line) => line.label)).toEqual(['0', '5', '10'])
    const time = chartGeometry({
      points: points([0, 54, 20]),
      bucket: 'day',
      sort: 'time',
      width: 800,
      height: 176
    })
    // The peak is 54 × 200_000 ms, which is 3h; the ladder puts the ticks on
    // whole hours rather than on 3,600,000-millisecond numbers.
    expect(time.gridlines.map((line) => line.label)).toEqual(['0m', '1h', '2h', '3h'])
  })

  it('never labels a count with a quantity a count cannot have', () => {
    // A peak of one over three intervals is a raw step of a third of a play.
    for (const peak of [1, 2, 3, 4]) {
      const labels = geometry([peak, 0]).gridlines.map((line) => line.label)
      expect(labels.every((label) => /^\d+$/u.test(label))).toBe(true)
    }
  })

  it('keeps the peak in the top third of the plot rather than reserving air', () => {
    // The step rounds up, so an axis aiming too low inflates: a peak of 11
    // topping out at 20 draws the tallest column at barely half height, which
    // reads as a quieter month than it was.
    for (const peak of [3, 7, 11, 21, 46, 99, 137, 1004]) {
      const chart = geometry([peak, 1])
      const filled = (chart.baseline - chart.marks[0].y) / chart.plot.h
      expect(filled).toBeGreaterThan(0.65)
      expect(filled).toBeLessThanOrEqual(1)
    }
  })

  it('draws nothing for an empty bucket and something for a tiny one', () => {
    const chart = geometry([400, 0, 1])
    expect(chart.columns[1].path).toBe('')
    expect(chart.columns[2].path).not.toBe('')
  })

  it('keeps every column inside its own band', () => {
    const chart = geometry([5, 9, 2, 7])
    const band = chart.plot.w / 4
    for (const column of chart.columns) {
      expect(column.hitW).toBeCloseTo(band, 1)
      expect(column.hitX).toBeGreaterThanOrEqual(chart.plot.x - 0.01)
    }
    expect(chart.columns[3].hitX + chart.columns[3].hitW).toBeCloseTo(
      chart.plot.x + chart.plot.w,
      1
    )
  })

  it('never rounds a corner larger than the mark it is rounding', () => {
    // One play against a peak of four hundred is a two-pixel column; a 4px
    // radius on it would invert the path and draw a bow tie.
    const chart = geometry([400, 1])
    expect(chart.columns[1].path).toMatch(/^M[\d.]+ [\d.]+V/u)
    expect(chart.columns[1].path).not.toContain('NaN')
  })

  it('names the busiest bucket, and names none when nothing was played', () => {
    expect(geometry([3, 19, 4]).peakIndex).toBe(1)
    expect(geometry([0, 0, 0]).peakIndex).toBe(-1)
  })

  it('labels both ends of the axis and thins what is between them', () => {
    const chart = geometry(new Array(30).fill(1))
    expect(chart.ticks.length).toBeGreaterThanOrEqual(2)
    expect(chart.ticks.length).toBeLessThanOrEqual(6)
    expect(chart.ticks[0].x).toBeCloseTo(chart.marks[0].x, 5)
    expect(chart.ticks[chart.ticks.length - 1].x).toBeCloseTo(
      chart.marks[chart.marks.length - 1].x,
      5
    )
  })

  it('places one tick for one bucket', () => {
    expect(geometry([4]).ticks).toHaveLength(1)
  })

  it('spreads the interior ticks evenly instead of leaving the last gap long', () => {
    // A stride walked from the left leaves whatever does not divide at the right
    // edge, which reads as a hole in the axis rather than as a scale.
    const chart = geometry(new Array(30).fill(1))
    const gaps = chart.ticks.slice(1).map((tick, index) => tick.x - chart.ticks[index].x)
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(chart.plot.w / 30 + 0.01)
  })

  it('never draws the same bucket twice when there are fewer than the slots', () => {
    const chart = geometry([1, 2, 3])
    expect(new Set(chart.ticks.map((tick) => tick.x)).size).toBe(chart.ticks.length)
    expect(chart.ticks).toHaveLength(3)
  })

  it('keeps every tick inside the plot', () => {
    for (const count of [1, 2, 7, 30, 365]) {
      const chart = geometry(new Array(count).fill(2))
      for (const tick of chart.ticks) {
        expect(tick.x).toBeGreaterThanOrEqual(chart.plot.x)
        expect(tick.x).toBeLessThanOrEqual(chart.plot.x + chart.plot.w)
      }
    }
  })
})

describe('bucketAtX', () => {
  it('reads the band the pointer is in', () => {
    const chart = geometry([1, 2, 3, 4])
    const band = chart.plot.w / 4
    expect(bucketAtX(chart, chart.plot.x + band * 0.5)).toBe(0)
    expect(bucketAtX(chart, chart.plot.x + band * 2.5)).toBe(2)
  })

  it('clamps at both edges rather than reporting nothing', () => {
    const chart = geometry([1, 2, 3, 4])
    expect(bucketAtX(chart, -50)).toBe(0)
    expect(bucketAtX(chart, chart.width + 50)).toBe(3)
  })

  it('has no answer when there is nothing drawn', () => {
    expect(bucketAtX(geometry([]), 100)).toBe(-1)
  })
})
