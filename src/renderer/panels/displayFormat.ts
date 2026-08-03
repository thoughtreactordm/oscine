import { computed } from 'vue'
import {
  DATE_FORMAT_KEY,
  DURATION_FORMAT_KEY,
  FILE_SIZE_FORMAT_KEY,
  TRACK_DENSITY_KEY,
  type DateFormat,
  type DurationFormat,
  type FileSizeFormat,
  type TrackDensity
} from '@shared/settings'
import type { SettingsReader } from '../settings/reader'

/**
 * How a duration, a date and a file size are written, and how tall a song list
 * row is.
 *
 * Its own module for the same reason as `groupingLayout`: these are pure
 * functions over a preference, they are worth testing without a DOM, and there
 * were four hand-rolled copies of two of them before this card — `TrackList`
 * formatted `M:SS` and divided by 1024 twice, `PodcastShowPane` formatted
 * `H:MM:SS` and a long date, `PodcastsSidebar` formatted a short one. Four
 * private answers to "how does this app write a number" is exactly the shape
 * W8-3 deleted from storage, one layer up.
 *
 * The density table is here rather than in the descriptor for the reason
 * `ALBUM_ART_SIZES` is: sizes are arithmetic before they are styling. The
 * virtualizer is told the height of every row in advance and scrolling a track
 * into view multiplies it out to a pixel offset, and a Tailwind class cannot be
 * added up. The registry decides which tiers exist; this decides what they
 * measure, and typing the table by the shared union is what makes adding a tier
 * there a compile error here rather than an undefined at runtime.
 */

/**
 * Row height per density tier, in CSS pixels.
 *
 * `default` is 32, which is what the list has always been — the tier exists so
 * that "put it back" is a choice on the same control rather than a revert.
 * Compact is 24 because that is the floor `text-sm` can sit on without its
 * descenders clipping, and roomy is 40 rather than 48 because the album header
 * at its smallest is 56 and a track row must stay visibly the lesser thing.
 */
export const TRACK_DENSITIES: Readonly<Record<TrackDensity, { label: string; row: number }>> = {
  compact: { label: 'Compact', row: 24 },
  default: { label: 'Default', row: 32 },
  roomy: { label: 'Roomy', row: 40 }
}

export const TRACK_DENSITY_KEYS = Object.keys(TRACK_DENSITIES) as readonly TrackDensity[]

/** Every row height a density change can produce — what a scroll anchor is rescaled by. */
export function trackRowPx(density: TrackDensity): number {
  return TRACK_DENSITIES[density].row
}

function clock(totalSec: number, withHours: boolean): string {
  const ss = String(totalSec % 60).padStart(2, '0')
  if (!withHours) return `${Math.floor(totalSec / 60)}:${ss}`
  const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0')
  return `${Math.floor(totalSec / 3600)}:${mm}:${ss}`
}

/**
 * A length in seconds, or the em dash when there is not one.
 *
 * The dash rather than `0:00`, because "we do not know how long this is" and
 * "this is instantaneous" are different facts and the column is read at a
 * glance. Negative and non-finite go the same way: a duration that came back
 * wrong should say so rather than render as a plausible number.
 */
export function formatDuration(seconds: number | null, format: DurationFormat): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  const whole = Math.round(seconds)
  return clock(whole, format === 'hours' || (format === 'auto' && whole >= 3600))
}

/** The same, for the milliseconds podcasts carry. Empty when absent — see the callers. */
export function formatDurationMs(ms: number | null, format: DurationFormat): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return ''
  return formatDuration(ms / 1000, format)
}

/**
 * An accumulated listening total: `18m`, `2h 18m`, `4d 6h`.
 *
 * Here rather than in a module of its own, because this file is where the app
 * decides how it writes a time and a second opinion about that is exactly what
 * the deck's stats pane must not introduce. It is *not* `formatDuration` with a
 * different argument, though, and that is why it is a second function: a length
 * is a position on a clock and reads `4:32`, while a total is a quantity and
 * reads `4d 6h`. Rendered as a clock, four years of listening is `9417:52:10`,
 * which is a number nobody can take in at a glance — and taking it in at a
 * glance is the entire point of putting it on a deck.
 *
 * Whole units only, and the minor one is dropped when it is zero: `3h` rather
 * than `3h 0m`. Anything under a minute rounds down to `0m` rather than growing
 * a seconds field, because a total small enough for seconds to matter is one
 * that has not happened yet, and `0m` beside `0 plays` says that already.
 *
 * Takes no preference. `DurationFormat` chooses whether a clock carries an
 * hours field, which is not a question this shape can be asked.
 */
export function formatListeningTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'

  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`

  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}

const DATE_OPTIONS: Readonly<Record<Exclude<DateFormat, 'iso'>, Intl.DateTimeFormatOptions>> = {
  short: { month: 'short', day: 'numeric' },
  medium: { year: 'numeric', month: 'short', day: 'numeric' },
  numeric: {}
}

/**
 * A date, from whatever the row carries.
 *
 * ISO is built from the *local* calendar fields rather than sliced off
 * `toISOString`, which would be UTC: an episode published at 22:00 on the third
 * is not a fourth-of-the-month episode to the person reading the list.
 *
 * Anything unparseable renders empty rather than as `Invalid Date`.
 */
export function formatDate(value: string | number | null, format: DateFormat): string {
  if (value === null || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  if (format !== 'iso') return date.toLocaleDateString(undefined, DATE_OPTIONS[format])
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const SIZE_UNITS: Readonly<
  Record<FileSizeFormat, { base: number; bytes: string; scaled: readonly [string, ...string[]] }>
> = {
  binary: { base: 1024, bytes: 'bytes', scaled: ['KiB', 'MiB', 'GiB', 'TiB'] },
  decimal: { base: 1000, bytes: 'bytes', scaled: ['kB', 'MB', 'GB', 'TB'] }
}

/**
 * A size in bytes, in the largest unit that leaves a number worth reading.
 *
 * One decimal below ten and none above it, which is the rule the track list
 * already used for megabytes: `4.7 MiB` and `312 MiB` carry the same amount of
 * information, and `312.4 MiB` carries a digit nobody is going to act on.
 */
export function formatFileSize(bytes: number | null, format: FileSizeFormat): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
  const { base, bytes: byteUnit, scaled } = SIZE_UNITS[format]
  if (bytes < base) return `${Math.round(bytes)} ${byteUnit}`

  let value = bytes / base
  let unit = scaled[0]
  for (const next of scaled.slice(1)) {
    if (value < base) break
    value /= base
    unit = next
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${unit}`
}

export interface DisplayFormatDeps {
  settings: SettingsReader
}

/**
 * The four preferences, bound to a reader.
 *
 * Returns functions rather than the format strings so that a caller reads
 * `formats.duration(track.durationSec)` and never learns which key that came
 * from. They are reactive because they read through `settings.get` on every
 * call, inside whatever effect called them — the same property that makes
 * `markAt` recompute a playing glyph without the row knowing. A consumer that
 * copied one into a plain `ref` at init would have opted out of W8-4.
 */
export function createDisplayFormats(deps: DisplayFormatDeps) {
  const { settings } = deps

  const density = computed(() => settings.get<TrackDensity>(TRACK_DENSITY_KEY))
  const rowPx = computed(() => trackRowPx(density.value))

  return {
    density,
    rowPx,
    duration: (seconds: number | null): string =>
      formatDuration(seconds, settings.get<DurationFormat>(DURATION_FORMAT_KEY)),
    durationMs: (ms: number | null): string =>
      formatDurationMs(ms, settings.get<DurationFormat>(DURATION_FORMAT_KEY)),
    date: (value: string | number | null): string =>
      formatDate(value, settings.get<DateFormat>(DATE_FORMAT_KEY)),
    fileSize: (bytes: number | null): string =>
      formatFileSize(bytes, settings.get<FileSizeFormat>(FILE_SIZE_FORMAT_KEY))
  }
}

export type DisplayFormats = ReturnType<typeof createDisplayFormats>
