import {
  ALL_TIME,
  MAX_STATS_BUCKETS,
  STATS_BUCKET_MS,
  STATS_SORTS,
  type StatsBucket,
  type StatsRange,
  type StatsSort
} from '@shared/stats'

/**
 * The dashboard's five presets, resolved against the operator's own calendar.
 *
 * **This is the side of the boundary that holds a clock.** `StatsRange` is two
 * integers precisely so that main never has to know which timezone's "this
 * year" it is being asked about, and this module is the other half of that
 * decision: everything about local midnight, the turn of the year and how wide
 * a bucket should be lives here and reaches main as `{ from, to }`.
 *
 * Pure and DOM-free, so it can be tested under the node config — which is also
 * why it takes `now` as an argument rather than reading the clock. A range
 * function that called `Date.now()` internally could only be tested against
 * whatever today happens to be.
 *
 * ## Day boundaries come from the calendar, not from arithmetic
 *
 * `startOfDay(now) - 6 * 86_400_000` is the obvious spelling of "seven days
 * ago" and it is wrong twice a year: across a DST transition it lands at 23:00
 * or 01:00 local, so the window starts an hour off and — because buckets anchor
 * at `from` — every day boundary in the chart moves with it. `new Date(y, m, d
 * - 6)` asks the platform's calendar instead and always lands on midnight.
 *
 * The buckets themselves are still fixed widths, per `StatsBucket`, so a DST
 * shift *inside* a window does slide the boundaries after it by an hour. That
 * is the shared contract's accepted cost and not something this side can fix by
 * choosing a better `from`; what it can do is make sure the first boundary is
 * right, which is the one the operator reads off the left edge.
 */

export const LISTENING_RANGE_KEY = 'view.listeningRange'
export const LISTENING_SORT_KEY = 'view.listeningSort'

export type ListeningRangeId = '7d' | '30d' | '90d' | 'year' | 'all'

export interface ListeningRangePreset {
  readonly id: ListeningRangeId
  readonly label: string
  /**
   * Whole local days the window covers, counting today.
   *
   * `null` for the two presets that are not a day count — "this year" is a
   * question about the calendar and "all time" is not a window at all.
   */
  readonly days: number | null
}

export const LISTENING_RANGES: readonly ListeningRangePreset[] = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'year', label: 'This year', days: null },
  { id: 'all', label: 'All time', days: null }
]

/**
 * Thirty days, because a dashboard is answering "lately".
 *
 * Seven is a week you can still remember without help and all-time is a
 * biography; thirty is long enough to have a shape and short enough that what
 * it shows is still what you are doing.
 */
export const DEFAULT_LISTENING_RANGE: ListeningRangeId = '30d'

/**
 * Plays, not time — and this is the one place the app picks a side.
 *
 * `StatsSort` is required rather than defaulted at the boundary exactly so that
 * the engine does not choose between two totals that tell different stories.
 * Something has to open, though, and the honest way to open on one is to put
 * the other under the operator's thumb: both totals are on every row, and the
 * toggle is beside the range. Plays first because it is the number people
 * already have an intuition for.
 */
export const DEFAULT_LISTENING_SORT: StatsSort = 'listens'

const DAY_MS = STATS_BUCKET_MS.day

/** Falls forward to the default rather than stranding the view on a blank panel. */
export function resolveRangeId(stored: string): ListeningRangeId {
  return LISTENING_RANGES.some((preset) => preset.id === stored)
    ? (stored as ListeningRangeId)
    : DEFAULT_LISTENING_RANGE
}

export function resolveSort(stored: string): StatsSort {
  return STATS_SORTS.some((sort) => sort === stored)
    ? (stored as StatsSort)
    : DEFAULT_LISTENING_SORT
}

export function rangeLabel(id: ListeningRangeId): string {
  return (LISTENING_RANGES.find((preset) => preset.id === id) ?? LISTENING_RANGES[0]).label
}

function startOfLocalDay(at: number, offsetDays = 0): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime()
}

/**
 * The last millisecond of the local day, not the caller's clock.
 *
 * `StatsRange` is closed at both ends, so this is genuinely the last instant in
 * the window. Ending at *now* would drop a listen whose `started_at` is a few
 * seconds ahead of this renderer's clock — which is not hypothetical on a
 * machine whose time is being corrected — and it would also leave the last
 * bucket of the chart a partial one that shrinks the graph's right edge every
 * time the view is reloaded.
 */
function endOfLocalDay(at: number): number {
  return startOfLocalDay(at, 1) - 1
}

/**
 * The window a preset stands for.
 *
 * "All time" is `ALL_TIME` — the same open-ended range the deck sends, with a
 * `to` past the end of the log rather than at the clock, so a row stamped in the
 * future is counted rather than quietly omitted. See `ALL_TIME`'s own note.
 */
export function rangeFor(id: ListeningRangeId, now: number): StatsRange {
  if (id === 'all') return ALL_TIME
  const to = endOfLocalDay(now)
  if (id === 'year') return { from: new Date(new Date(now).getFullYear(), 0, 1).getTime(), to }

  const days = LISTENING_RANGES.find((preset) => preset.id === id)?.days ?? 30
  return { from: startOfLocalDay(now, 1 - days), to }
}

/** Two days of hours, then just over a year of days, then weeks. */
const HOUR_SPAN_MS = 2 * DAY_MS
const DAY_SPAN_MS = 400 * DAY_MS

/**
 * How wide a bucket has to be for the span to stay readable.
 *
 * The thresholds are chosen so that every preset lands where you would draw it
 * by hand: seven and thirty and ninety days are days, "this year" is days right
 * up to the 366th, and all-time is weeks the moment the log outgrows a year.
 * The hour bucket only ever appears under all-time on a log younger than two
 * days — which is exactly the first-week case where a daily chart would be
 * three columns and say nothing.
 */
export function bucketFor(spanMs: number): StatsBucket {
  if (spanMs <= HOUR_SPAN_MS) return 'hour'
  if (spanMs <= DAY_SPAN_MS) return 'day'
  return 'week'
}

export interface ListeningSeriesQuery {
  readonly range: StatsRange
  readonly bucket: StatsBucket
}

/**
 * The over-time query, which is not always the ranking's range.
 *
 * For the four bounded presets it is exactly that range, empty buckets and all —
 * a week with three silent days in it *is* the shape of that week, and a chart
 * that omitted them would draw a straight line across the days you were away.
 *
 * "All time" cannot be, and that is the whole reason this function exists.
 * `ALL_TIME` runs from the epoch, so a daily series over it is nineteen thousand
 * buckets of nothing followed by the year you actually own music in — past
 * `MAX_STATS_BUCKETS` and, long before that, past anything worth drawing. So the
 * series starts at the first listen instead, which is why the dashboard asks for
 * its summary before its series rather than issuing both together: `firstListenAt`
 * is the left edge, and only the summary knows it.
 *
 * That leaves one honest seam under all-time: a listen stamped in the future is
 * inside `ALL_TIME` and counted in the headline totals, but sits past the right
 * edge of a chart that ends today. Counting it and not drawing it is the better
 * pair of wrongs — the alternative stretches the axis to a clock error.
 *
 * `null` when there is nothing to draw at all.
 */
export function seriesFor(
  id: ListeningRangeId,
  range: StatsRange,
  firstListenAt: number | null,
  now: number
): ListeningSeriesQuery | null {
  if (firstListenAt === null) return null

  const to = id === 'all' ? endOfLocalDay(now) : range.to
  const from = id === 'all' ? startOfLocalDay(Math.min(firstListenAt, now)) : range.from
  if (to < from) return null

  const bucket = bucketFor(to - from)
  return { range: clampToBucketCeiling({ from, to }, bucket), bucket }
}

/**
 * The last line of defence against a refused query.
 *
 * `MAX_STATS_BUCKETS` is refused rather than clamped at the boundary, correctly
 * — a caller asking for 87,600 points has a wrong belief about what it will get.
 * This side is the caller, so it is this side's job not to hold that belief. No
 * preset reaches the ceiling; a machine whose clock once read 1970, or 2140, can
 * put a listen in the log that does, and the chart losing its oldest weeks beats
 * the whole dashboard failing on one bad row.
 */
function clampToBucketCeiling(range: StatsRange, bucket: StatsBucket): StatsRange {
  const width = STATS_BUCKET_MS[bucket]
  const buckets = Math.floor((range.to - range.from) / width) + 1
  if (buckets <= MAX_STATS_BUCKETS) return range
  return { from: range.to - (MAX_STATS_BUCKETS - 1) * width, to: range.to }
}
