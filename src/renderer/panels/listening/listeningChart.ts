import type { StatsBucket, StatsOverTimePoint, StatsSort } from '@shared/stats'
import { formatListeningTime } from '../displayFormat'

/**
 * The over-time chart, as arithmetic.
 *
 * ## Why there is no charting library here
 *
 * The card asked for this decision to be made out loud rather than let a
 * dependency land by accident, so: **inline SVG, no library.** The shape is one
 * series over a uniform grid of buckets with a zero baseline — a scale, a path
 * and some ticks. Every candidate (Chart.js, uPlot, a d3 subset) arrives with a
 * canvas renderer or a DOM layer of its own, its own idea of a colour, its own
 * tooltip, and a theming seam that would have to be bridged back to the token
 * layer one property at a time. M5's exit criterion is that swapping a theme
 * touches zero component code, and the fastest way to fail it is to hand the
 * drawing to something that does not read CSS custom properties.
 *
 * What a library would genuinely buy — pan, zoom, brushing, a second axis, a
 * million points on canvas — this chart does not want. It is capped at a few
 * hundred buckets by `MAX_STATS_BUCKETS` and by `listeningRange.ts` choosing a
 * bucket width, and a few hundred `<path>` elements is not a rendering problem.
 * **Revisit when** a surface here needs zoom or brushing over a series the
 * renderer cannot bound — W10-14's retrospective is the plausible trigger.
 *
 * ## Why it is a module and not a component
 *
 * Every number below is testable without a DOM, and most of the ways a chart
 * goes wrong are arithmetic: an axis that does not start at zero, a bar wider
 * than its band, a rounded corner larger than the bar it is rounding, a tick
 * that lands off the plot. The `.vue` file is a `<path>` per entry in what this
 * returns and holds no geometry of its own.
 *
 * Colour appears nowhere here. The component paints with `currentColor` against
 * the token layer's text classes, which is what keeps the chart theme-swappable
 * without a single hex literal in the renderer.
 */

/** The y-axis gutter, wide enough for `12,000` and `10d 4h` at `text-xs`. */
const AXIS_GUTTER_PX = 46
/** The band under the plot that the x labels sit in — see the anti-pattern about a chart whose fixed height excludes its own axis. */
const LABEL_BAND_PX = 16
const TOP_PAD_PX = 8

/**
 * Narrowest band that can still hold a column and its gap.
 *
 * Below this the columns stop being marks and become a solid block with combing
 * in it, so the form changes to an area — which is the honest mark for a series
 * too dense to resolve individually anyway. Six pixels of column and the two-pixel
 * surface gap between neighbours.
 */
const MIN_COLUMN_BAND_PX = 8
const COLUMN_GAP_PX = 2
/** Columns are capped rather than filling their band: a seven-day chart is seven marks, not seven slabs. */
const MAX_COLUMN_PX = 24
const CORNER_PX = 4
/**
 * The floor on a non-zero column.
 *
 * One play against a peak of four hundred is a quarter of a pixel, which draws
 * as nothing — and "nothing" is already what a genuine zero draws as. Two
 * pixels overstates that bucket by a hair and keeps the two facts distinct,
 * which is the trade every bar chart makes at the bottom of its scale.
 */
const MIN_COLUMN_HEIGHT_PX = 2

export type ChartForm = 'columns' | 'area' | 'empty'

export interface ChartPlot {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface ChartColumn {
  readonly index: number
  /** The rounded-top, square-bottomed mark. Empty for a bucket with nothing in it. */
  readonly path: string
  /** Left edge and width of the *hit target*, which is the whole band. */
  readonly hitX: number
  readonly hitW: number
}

export interface ChartGridline {
  readonly y: number
  readonly label: string
}

export interface ChartTick {
  readonly x: number
  readonly label: string
}

/**
 * One bucket's position: the centre of its band, and its value on the axis.
 *
 * Both forms need both numbers — the crosshair and the ticks want `x`, and the
 * area form's cursor dot wants `y` — so they are computed once here rather than
 * recovered in the template, which is where a chart grows a second scale.
 */
export interface ChartMark {
  readonly x: number
  readonly y: number
}

export interface ChartGeometry {
  readonly form: ChartForm
  readonly width: number
  readonly height: number
  readonly plot: ChartPlot
  readonly baseline: number
  readonly columns: readonly ChartColumn[]
  /** The wash under the line. Empty unless `form` is `area`. */
  readonly areaPath: string
  readonly linePath: string
  readonly gridlines: readonly ChartGridline[]
  readonly ticks: readonly ChartTick[]
  /** One entry per bucket, in order — the crosshair, the tick and the cursor dot. */
  readonly marks: readonly ChartMark[]
  /** The busiest bucket, which is the one the readout direct-labels. `-1` when empty. */
  readonly peakIndex: number
}

export interface ChartInput {
  readonly points: readonly StatsOverTimePoint[]
  readonly bucket: StatsBucket
  readonly sort: StatsSort
  readonly width: number
  readonly height: number
}

export function valueOf(point: StatsOverTimePoint, sort: StatsSort): number {
  return sort === 'listens' ? point.listens : point.msListened
}

/** Counts round to one, two or five; there is no such thing as half a play. */
const COUNT_STEPS = [1, 2, 5] as const

/**
 * Where a time axis is allowed to put a tick.
 *
 * A ladder rather than powers of ten, because time is not decimal and
 * `2,700,000 ms` is not a label. Every rung is a duration a person would say
 * out loud, so `formatListeningTime` writes each of them as one clean unit.
 */
const TIME_STEPS_MS = [
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000,
  21_600_000, 43_200_000, 86_400_000, 172_800_000, 432_000_000, 864_000_000, 1_728_000_000,
  4_320_000_000
] as const

/**
 * Intervals the axis aims for between zero and the top.
 *
 * Three, and the number is a compromise between two ways of looking silly. The
 * step is rounded *up* to a number a person would say, so a smaller target
 * inflates the axis — at two intervals a peak of 11 gets a top of 20 and the
 * tallest column fills barely half the plot. More intervals track the peak more
 * closely and put more hairlines across a 176-pixel chart than it can carry.
 * Three keeps three or four gridlines on screen and the peak above about
 * seventy percent of the height.
 */
const TARGET_INTERVALS = 3

function niceStep(value: number, sort: StatsSort): number {
  if (value <= 0) return sort === 'listens' ? 1 : 60_000

  if (sort === 'time') {
    const rung = TIME_STEPS_MS.find((step) => step >= value)
    if (rung !== undefined) return rung
    // Past the ladder, keep going in whole days on the same 1/2/5 rhythm.
    const days = Math.ceil(value / 86_400_000)
    const magnitude = 10 ** Math.floor(Math.log10(days))
    const step = COUNT_STEPS.find((candidate) => candidate * magnitude >= days) ?? 10
    return step * magnitude * 86_400_000
  }

  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = COUNT_STEPS.find((candidate) => candidate * magnitude >= value) ?? 10
  // Never below one: a play is not divisible, and an axis reading `0 / 0.5 / 1`
  // labels a count with a quantity that cannot occur.
  return Math.max(1, step * magnitude)
}

function axisLabel(value: number, sort: StatsSort): string {
  return sort === 'listens' ? value.toLocaleString() : formatListeningTime(value)
}

/**
 * The axis: zero, a step, and as many more as the data needs.
 *
 * **Always from zero.** A bar whose baseline is not zero lies about its own
 * length, and this chart's whole job is that a tall week looks taller than a
 * quiet one.
 *
 * The interval count is `TARGET_INTERVALS` unless the rounded step lands short
 * of the peak, in which case it grows — which is the right way round, because
 * an axis that stopped below the tallest column would draw it off the plot.
 */
function axisTicks(max: number, sort: StatsSort): { top: number; values: number[] } {
  const step = niceStep(max / TARGET_INTERVALS, sort)
  const count = Math.max(2, Math.ceil(max / step))
  const values: number[] = []
  for (let index = 0; index <= count; index += 1) values.push(index * step)
  return { top: count * step, values }
}

function columnPath(x: number, w: number, top: number, base: number): string {
  const height = base - top
  if (height <= 0) return ''
  const radius = Math.min(CORNER_PX, w / 2, height)
  const right = x + w

  // Square at the baseline, rounded at the data end — the mark grows from the
  // axis and only its tip is soft, so the reader can still line two bars up.
  return [
    `M${x} ${base}`,
    `V${top + radius}`,
    `A${radius} ${radius} 0 0 1 ${x + radius} ${top}`,
    `H${right - radius}`,
    `A${radius} ${radius} 0 0 1 ${right} ${top + radius}`,
    `V${base}`,
    'Z'
  ].join('')
}

const EMPTY_PLOT: ChartPlot = { x: 0, y: 0, w: 0, h: 0 }

export function chartGeometry(input: ChartInput): ChartGeometry {
  const { points, sort } = input
  const width = Math.max(0, input.width)
  const height = Math.max(0, input.height)

  const plot: ChartPlot = {
    x: AXIS_GUTTER_PX,
    y: TOP_PAD_PX,
    w: Math.max(0, width - AXIS_GUTTER_PX),
    h: Math.max(0, height - TOP_PAD_PX - LABEL_BAND_PX)
  }
  const baseline = plot.y + plot.h

  if (points.length === 0 || plot.w <= 0 || plot.h <= 0) {
    return {
      form: 'empty',
      width,
      height,
      plot: points.length === 0 ? plot : EMPTY_PLOT,
      baseline,
      columns: [],
      areaPath: '',
      linePath: '',
      gridlines: [],
      ticks: [],
      marks: [],
      peakIndex: -1
    }
  }

  const values = points.map((point) => valueOf(point, sort))
  const max = Math.max(...values)
  const peakIndex = max <= 0 ? -1 : values.indexOf(max)
  const axis = axisTicks(max, sort)

  const band = plot.w / points.length
  const yFor = (value: number): number => baseline - (value / axis.top) * plot.h
  const marks = points.map((_, index) => ({
    x: round(plot.x + (index + 0.5) * band),
    y: round(yFor(values[index]))
  }))

  const gridlines = axis.values.map((value) => ({
    y: yFor(value),
    label: axisLabel(value, sort)
  }))

  const ticks = tickLabels(points, marks, plot.w, input.bucket)

  if (band >= MIN_COLUMN_BAND_PX) {
    const columnW = Math.min(MAX_COLUMN_PX, band - COLUMN_GAP_PX)
    const columns = points.map((_, index) => {
      const value = values[index]
      const top = value <= 0 ? baseline : Math.min(yFor(value), baseline - MIN_COLUMN_HEIGHT_PX)
      return {
        index,
        path: columnPath(round(marks[index].x - columnW / 2), columnW, round(top), baseline),
        hitX: round(plot.x + index * band),
        hitW: round(band)
      }
    })

    return {
      form: 'columns',
      width,
      height,
      plot,
      baseline,
      columns,
      areaPath: '',
      linePath: '',
      gridlines,
      ticks,
      marks,
      peakIndex
    }
  }

  const line = marks.map((mark, index) => `${index === 0 ? 'M' : 'L'}${mark.x} ${mark.y}`).join('')
  const last = marks[marks.length - 1]

  return {
    form: 'area',
    width,
    height,
    plot,
    baseline,
    columns: [],
    areaPath: `${line}L${last.x} ${baseline}L${marks[0].x} ${baseline}Z`,
    linePath: line,
    gridlines,
    ticks,
    marks,
    peakIndex
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * As many x labels as fit without touching, evenly spread, both ends always.
 *
 * The spread is computed from the *ends inwards* — index `i` of `slots` lands at
 * `i·(n-1)/(slots-1)` — rather than by walking a stride from the left. The
 * difference shows up at the right edge: a stride that does not divide the
 * series leaves a last gap of whatever is left over, so a thirty-day chart reads
 * `Jul 5 · Jul 11 · Jul 17 · Jul 23 · Aug 3` and the eye reads the final jump as
 * missing days. Both are legal placements and only one of them looks like a
 * scale.
 *
 * `Set` because the rounding collides when there are fewer buckets than slots,
 * and a duplicated label is a label drawn twice on the same pixel.
 *
 * Nothing is rotated: a diagonal date is a date nobody reads, and a chart that
 * needs rotation needs fewer labels.
 */
function tickLabels(
  points: readonly StatsOverTimePoint[],
  marks: readonly ChartMark[],
  plotW: number,
  bucket: StatsBucket
): ChartTick[] {
  if (points.length === 1) {
    return [{ x: marks[0].x, label: formatBucketLabel(points[0].startedAt, bucket) }]
  }

  const slots = Math.max(2, Math.min(6, Math.floor(plotW / 72)))
  const last = points.length - 1
  const indexes = new Set<number>()
  for (let slot = 0; slot < slots; slot += 1) {
    indexes.add(Math.round((slot * last) / (slots - 1)))
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      x: marks[index].x,
      label: formatBucketLabel(points[index].startedAt, bucket)
    }))
}

/** The short form, for an axis tick. */
export function formatBucketLabel(startedAt: number, bucket: StatsBucket): string {
  const date = new Date(startedAt)
  if (bucket === 'hour') return date.toLocaleTimeString(undefined, { hour: 'numeric' })
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The long form, for the readout above the plot, where there is room to be exact. */
export function formatBucketSpan(startedAt: number, bucket: StatsBucket): string {
  const date = new Date(startedAt)
  if (bucket === 'hour') {
    const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    return `${day}, ${date.toLocaleTimeString(undefined, { hour: 'numeric' })}`
  }
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
  return bucket === 'week' ? `Week of ${day}` : day
}

/**
 * Which bucket the pointer is nearest — not which one it is over.
 *
 * The hit target is the whole band on a column chart and the nearest centre on
 * an area chart, so the reader aims at a date rather than at a two-pixel mark.
 * Clamped rather than returning `-1` outside the plot: the pointer only reaches
 * here while it is inside the chart, and an off-by-a-pixel at the right edge
 * should read the last bucket, not none.
 */
export function bucketAtX(geometry: ChartGeometry, x: number): number {
  const { marks } = geometry
  if (marks.length === 0) return -1
  const band = geometry.plot.w / marks.length
  const index = Math.floor((x - geometry.plot.x) / band)
  return Math.min(marks.length - 1, Math.max(0, index))
}
