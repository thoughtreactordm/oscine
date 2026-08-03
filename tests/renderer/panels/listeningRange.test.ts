import { describe, expect, it } from 'vitest'
import {
  bucketFor,
  DEFAULT_LISTENING_RANGE,
  DEFAULT_LISTENING_SORT,
  LISTENING_RANGES,
  rangeFor,
  resolveRangeId,
  resolveSort,
  seriesFor
} from '../../../src/renderer/panels/listening/listeningRange'
import { ALL_TIME, MAX_STATS_BUCKETS, STATS_BUCKET_MS } from '@shared/stats'

const DAY_MS = STATS_BUCKET_MS.day

/** A fixed local afternoon, so every expectation below can be written by hand. */
function at(year: number, month: number, day: number, hour = 15, minute = 30): number {
  return new Date(year, month - 1, day, hour, minute).getTime()
}

function startOfDay(now: number, offsetDays = 0): number {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime()
}

describe('resolveRangeId', () => {
  it('accepts every preset it offers', () => {
    for (const preset of LISTENING_RANGES) {
      expect(resolveRangeId(preset.id)).toBe(preset.id)
    }
  })

  it('falls forward to the default rather than stranding the view', () => {
    expect(resolveRangeId('')).toBe(DEFAULT_LISTENING_RANGE)
    expect(resolveRangeId('decade')).toBe(DEFAULT_LISTENING_RANGE)
  })
})

describe('resolveSort', () => {
  it('accepts both totals and nothing else', () => {
    expect(resolveSort('listens')).toBe('listens')
    expect(resolveSort('time')).toBe('time')
    expect(resolveSort('')).toBe(DEFAULT_LISTENING_SORT)
    expect(resolveSort('msListened')).toBe(DEFAULT_LISTENING_SORT)
  })
})

describe('rangeFor', () => {
  const now = at(2026, 8, 3)

  it('ends at the last millisecond of the local day, not at the clock', () => {
    const range = rangeFor('7d', now)
    expect(range.to).toBe(startOfDay(now, 1) - 1)
    expect(range.to).toBeGreaterThan(now)
  })

  it('counts today as one of the days', () => {
    // Seven days ending today starts six midnights ago, not seven.
    expect(rangeFor('7d', now).from).toBe(startOfDay(now, -6))
    expect(rangeFor('30d', now).from).toBe(startOfDay(now, -29))
    expect(rangeFor('90d', now).from).toBe(startOfDay(now, -89))
  })

  it('starts "this year" at the local turn of the year', () => {
    const range = rangeFor('year', now)
    expect(range.from).toBe(new Date(2026, 0, 1).getTime())
    expect(new Date(range.from).getHours()).toBe(0)
  })

  it('sends the open-ended range for all time, so a future-stamped row still counts', () => {
    expect(rangeFor('all', now)).toEqual(ALL_TIME)
  })

  it('lands on local midnight even when the window crosses a DST transition', () => {
    // Whatever this machine's zone does in March and November, a window built
    // from the calendar starts at midnight; one built by subtracting
    // 86_400_000 ms per day would be an hour out on one side of the change.
    for (const day of [at(2026, 3, 20), at(2026, 11, 10)]) {
      for (const preset of ['7d', '30d', '90d'] as const) {
        expect(new Date(rangeFor(preset, day).from).getHours()).toBe(0)
      }
    }
  })
})

describe('bucketFor', () => {
  it('draws hours only for a span too short to have days in it', () => {
    expect(bucketFor(DAY_MS)).toBe('hour')
    expect(bucketFor(2 * DAY_MS)).toBe('hour')
    expect(bucketFor(2 * DAY_MS + 1)).toBe('day')
  })

  it('draws days through a whole year and weeks past it', () => {
    expect(bucketFor(7 * DAY_MS)).toBe('day')
    expect(bucketFor(366 * DAY_MS)).toBe('day')
    expect(bucketFor(400 * DAY_MS)).toBe('day')
    expect(bucketFor(400 * DAY_MS + 1)).toBe('week')
    expect(bucketFor(4 * 365 * DAY_MS)).toBe('week')
  })
})

describe('seriesFor', () => {
  const now = at(2026, 8, 3)

  it('has nothing to draw when the range holds no listens', () => {
    expect(seriesFor('30d', rangeFor('30d', now), null, now)).toBeNull()
    expect(seriesFor('all', rangeFor('all', now), null, now)).toBeNull()
  })

  it('draws a bounded preset over exactly its own range, empty buckets and all', () => {
    const range = rangeFor('30d', now)
    const series = seriesFor('30d', range, at(2026, 7, 20), now)
    expect(series).not.toBeNull()
    expect(series?.range).toEqual(range)
    expect(series?.bucket).toBe('day')
  })

  it('starts all-time at the first listen rather than at the epoch', () => {
    const first = at(2022, 4, 9, 21, 5)
    const series = seriesFor('all', rangeFor('all', now), first, now)
    expect(series?.range.from).toBe(startOfDay(first))
    expect(series?.range.to).toBe(startOfDay(now, 1) - 1)
    // Four years of it is weeks; the epoch would have been nineteen thousand
    // daily buckets of nothing, and past MAX_STATS_BUCKETS besides.
    expect(series?.bucket).toBe('week')
  })

  it('draws a brand-new log by the hour', () => {
    const series = seriesFor('all', rangeFor('all', now), at(2026, 8, 3, 9), now)
    expect(series?.bucket).toBe('hour')
  })

  it('never asks for more buckets than the boundary will return', () => {
    // A machine whose clock once read 1970 puts a listen in the log that would
    // otherwise blow the ceiling and have the whole query refused.
    const series = seriesFor('all', rangeFor('all', now), 0, now)
    expect(series).not.toBeNull()
    const width = STATS_BUCKET_MS[series?.bucket ?? 'week']
    const buckets = Math.floor(((series?.range.to ?? 0) - (series?.range.from ?? 0)) / width) + 1
    expect(buckets).toBeLessThanOrEqual(MAX_STATS_BUCKETS)
  })

  it('keeps every preset inside the ceiling', () => {
    for (const preset of LISTENING_RANGES) {
      const range = rangeFor(preset.id, now)
      const series = seriesFor(preset.id, range, at(2016, 1, 1), now)
      expect(series).not.toBeNull()
      const width = STATS_BUCKET_MS[series?.bucket ?? 'day']
      const span = (series?.range.to ?? 0) - (series?.range.from ?? 0)
      expect(Math.floor(span / width) + 1).toBeLessThanOrEqual(MAX_STATS_BUCKETS)
    }
  })
})
