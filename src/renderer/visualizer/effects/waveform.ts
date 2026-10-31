import { follow } from './draw2d'

/**
 * The waveform reader Trace and Whorl share (W23-7): a triggered, auto-scaled,
 * tapered resample of the raw tap into a fixed number of points.
 *
 * - **Triggered** on a rising zero crossing, so a steady tone stands still
 *   rather than crawling.
 * - **Auto-scaled** by a slow peak follower, so a quiet master still draws a
 *   shape: the gain holds the follower at {@link GAIN_TARGET}, within
 *   {@link GAIN_MIN}..{@link GAIN_MAX}.
 * - **Tapered** to 0 at both ends (`√sin`), so an open ribbon is pinned to its
 *   centre line and a closed ring has no seam.
 *
 * DOM-free and allocation-free per read.
 */

const GAIN_TARGET = 0.9
const GAIN_MIN = 1
const GAIN_MAX = 8
const PEAK_RELEASE_SEC = 1.5

/**
 * The first rising zero crossing that still leaves `span` samples after it,
 * or 0 when there is none — the start of the span a triggered scope draws.
 */
export function triggerIndex(samples: ArrayLike<number>, span: number): number {
  const limit = samples.length - span
  for (let index = 1; index <= limit; index++) {
    if (samples[index - 1] < 0 && samples[index] >= 0) return index
  }
  return 0
}

export interface WaveformReader {
  /** The resampled shape, −1..1 per point, already tapered. The same array every read. */
  readonly points: Float32Array
  /** Read half the tap's length from the trigger into {@link points}. */
  read(samples: ArrayLike<number>, dtSec: number): void
}

export function createWaveformReader(count: number): WaveformReader {
  const points = new Float32Array(count)
  const taper = new Float32Array(count)
  for (let point = 0; point < count; point++) {
    taper[point] = count > 1 ? Math.sqrt(Math.sin((point / (count - 1)) * Math.PI)) : 0
  }
  let peak = GAIN_TARGET

  return {
    points,
    read(samples, dtSec) {
      const length = samples.length
      const span = length >> 1
      const start = triggerIndex(samples, span)
      let framePeak = 0
      for (let index = start; index < start + span; index++) {
        const value = samples[index] < 0 ? -samples[index] : samples[index]
        if (value > framePeak) framePeak = value
      }
      peak =
        framePeak > peak ? framePeak : peak + (framePeak - peak) * follow(dtSec, PEAK_RELEASE_SEC)
      let gain = peak > 0 ? GAIN_TARGET / peak : GAIN_MAX
      gain = gain < GAIN_MIN ? GAIN_MIN : gain > GAIN_MAX ? GAIN_MAX : gain
      const step = count > 1 && span > 0 ? (span - 1) / (count - 1) : 0
      for (let point = 0; point < count; point++) {
        const sample = span > 0 ? samples[start + Math.round(point * step)] : 0
        const value = sample * gain
        points[point] = (value < -1 ? -1 : value > 1 ? 1 : value) * taper[point]
      }
    }
  }
}
