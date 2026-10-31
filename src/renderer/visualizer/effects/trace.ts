import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'

/**
 * **Trace** — W23-7, D35.9: the waveform as a slow-drifting ribbon with fading
 * afterimages.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
 *
 * - **The ribbon** is the waveform tap, triggered on a rising zero crossing so a
 *   steady tone stands still rather than crawling, auto-scaled by a slow peak
 *   follower, and tapered to the centre line at both ends. Its centre sways and
 *   tilts slowly on two incommensurate periods, so it never repeats a pose. It
 *   is a wide `--ui-primary` band under a thin `--ui-text-highlighted` core.
 * - **The afterimages** are earlier ribbons, kept as a ring of snapshots taken
 *   every {@link SNAPSHOT_SEC} of clamped time, not every frame, and drawn at
 *   `e^(−age/τ)` as they drift up, scroll left and widen. Redrawing
 *   them, rather than fading a canvas into itself, is what keeps persistence
 *   exactly `dtSec`-driven: an 8-bit canvas faded by a fraction per frame keeps
 *   a ghost it can never round away, and fades at a rate set by the frame rate.
 *
 * Every array is made in `create`; a frame writes into them in place.
 */

/** Snapshot spacing and count: ~0.9 s of history. */
const SNAPSHOT_SEC = 1 / 24
const SNAPSHOTS = 22
/** Afterimage persistence: opacity is `e^(−age/τ)`. */
const AFTERIMAGE_TAU_SEC = 0.3
const AFTERIMAGE_ALPHA = 0.5
/** Below this an afterimage is not drawn at all. */
const AFTERIMAGE_FLOOR = 0.01
/** Per second of age: rise (× height), scroll (× width), widen (× amplitude). */
const RISE = 0.05
const SCROLL = 0.06
const WIDEN = 0.9

/** The ribbon's amplitude at full scale, as a fraction of the height. */
const AMPLITUDE = 0.26
/** Sway and tilt, as fractions of the height, and their periods in seconds. */
const SWAY = 0.08
const SWAY_PERIOD_SEC = 17
const TILT = 0.1
const TILT_PERIOD_SEC = 29
/** Auto-scale: the follower is held at this; the gain never leaves the range. */
const GAIN_TARGET = 0.9
const GAIN_MIN = 1
const GAIN_MAX = 8
const PEAK_RELEASE_SEC = 1.5
/** The band's width (× shorter side) at rest and how much the level adds. */
const BAND_WIDTH = 0.008
const BAND_LEVEL_WIDTH = 0.012
const BAND_ALPHA = 0.5
const CORE_ALPHA = 0.9

const POINTS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 96, auto: 160, high: 240 }

/**
 * The first rising zero crossing in the first half of `samples`, or 0 when
 * there is none — the start of the span a triggered scope draws.
 */
export function triggerIndex(samples: ArrayLike<number>, span: number): number {
  const limit = samples.length - span
  for (let index = 1; index <= limit; index++) {
    if (samples[index - 1] < 0 && samples[index] >= 0) return index
  }
  return 0
}

export function createTrace<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const points = POINTS_BY_QUALITY[quality]
  /** The taper: 0 at both ends, 1 across the middle. */
  const taper = new Float32Array(points)
  for (let point = 0; point < points; point++) {
    taper[point] = Math.sqrt(Math.sin((point / (points - 1)) * Math.PI))
  }
  const live = new Float32Array(points)
  const amplitudes = new Float32Array(points * SNAPSHOTS)
  const centres = new Float32Array(SNAPSHOTS)
  const tilts = new Float32Array(SNAPSHOTS)
  /** Infinite = an empty slot. */
  const ages = new Float32Array(SNAPSHOTS).fill(Infinity)

  let width = 0
  let height = 0
  let head = 0
  let sinceSnapshot = 0
  let swayPhase = 0
  let tiltPhase = 0
  let peak = GAIN_TARGET

  /** Read this frame's ribbon into `live`, in amplitude units (×1 = full scale). */
  function readLive(samples: ArrayLike<number>, dtSec: number): void {
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
    const step = points > 1 ? (span - 1) / (points - 1) : 0
    for (let point = 0; point < points; point++) {
      const sample = length > 0 ? samples[start + Math.round(point * step)] : 0
      const value = sample * gain
      live[point] = (value < -1 ? -1 : value > 1 ? 1 : value) * taper[point]
    }
  }

  function snapshot(centre: number, tilt: number): void {
    amplitudes.set(live, head * points)
    centres[head] = centre
    tilts[head] = tilt
    ages[head] = 0
    head = (head + 1) % SNAPSHOTS
  }

  /** Trace one ribbon as an open path; the caller strokes it. */
  function path(
    source: Float32Array,
    offset: number,
    centre: number,
    tilt: number,
    amplitudePx: number,
    shiftX: number
  ): void {
    ctx.beginPath()
    const stepX = width / (points - 1)
    for (let point = 0; point < points; point++) {
      const x = point * stepX - shiftX
      const y = centre + tilt * (point / (points - 1) - 0.5) + source[offset + point] * amplitudePx
      if (point === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.clearRect(0, 0, width, height)

      swayPhase = (swayPhase + (dtSec / SWAY_PERIOD_SEC) * Math.PI * 2) % (Math.PI * 2)
      tiltPhase = (tiltPhase + (dtSec / TILT_PERIOD_SEC) * Math.PI * 2) % (Math.PI * 2)
      for (let slot = 0; slot < SNAPSHOTS; slot++) ages[slot] += dtSec
      readLive(audio.waveform, dtSec)

      // Positions are kept as fractions of the height, so a resize keeps the history.
      const centre = 0.5 + Math.sin(swayPhase) * SWAY
      const tilt = Math.sin(tiltPhase) * TILT
      sinceSnapshot += dtSec
      if (sinceSnapshot >= SNAPSHOT_SEC) {
        sinceSnapshot %= SNAPSHOT_SEC
        snapshot(centre, tilt)
      }
      if (width <= 0 || height <= 0 || points < 2) return

      const intensity = stage.intensity
      const short = width < height ? width : height
      const amplitudePx = height * AMPLITUDE
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // Afterimages, oldest first so the newest lie on top.
      ctx.strokeStyle = palette.css[PaletteSlot.accent]
      ctx.lineWidth = Math.max(1, short * BAND_WIDTH * 0.5)
      for (let n = 0; n < SNAPSHOTS; n++) {
        const slot = (head + n) % SNAPSHOTS
        const age = ages[slot]
        const fade = Math.exp(-age / AFTERIMAGE_TAU_SEC) * AFTERIMAGE_ALPHA
        if (!(fade >= AFTERIMAGE_FLOOR)) continue
        ctx.globalAlpha = fade * intensity
        path(
          amplitudes,
          slot * points,
          (centres[slot] - age * RISE) * height,
          tilts[slot] * height,
          amplitudePx * (1 + age * WIDEN),
          age * SCROLL * width
        )
        ctx.stroke()
      }

      // The ribbon now: a band, then its core.
      ctx.globalAlpha = BAND_ALPHA * intensity
      ctx.lineWidth = Math.max(1, short * (BAND_WIDTH + audio.level * BAND_LEVEL_WIDTH))
      path(live, 0, centre * height, tilt * height, amplitudePx, 0)
      ctx.stroke()
      ctx.globalAlpha = CORE_ALPHA * intensity
      ctx.strokeStyle = palette.css[PaletteSlot.textHighlighted]
      ctx.lineWidth = Math.max(1, short * 0.002)
      ctx.stroke()

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}
