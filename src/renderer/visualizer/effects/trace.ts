import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'
import { createDrive } from './drive'
import { createWaveformReader } from './waveform'

/**
 * **Trace** — W23-7, D35.9: the waveform as a slow-drifting ribbon with fading
 * afterimages.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
 *
 * - **The ribbon** is the shared waveform reader's shape (triggered, auto-
 *   scaled, tapered). Its amplitude follows the level and leaps on the beat —
 *   the reader's auto-scale is undone here, so a chorus draws bigger than a
 *   verse. It climbs for a bright (high-pitched) spectrum and sinks for a dark
 *   one, and sways and tilts slowly on two incommensurate periods. It is a
 *   wide `--ui-primary` band, thickening with level and beat, under a thin
 *   `--ui-text-highlighted` core.
 * - **The afterimages** are earlier ribbons, a snapshot every
 *   {@link SNAPSHOT_SEC} of clamped time. Each keeps its own rise, scroll,
 *   widening and fade, integrated every frame from the drive as it is now: as
 *   the song heats up they stream away faster and live longer (up to
 *   {@link MAX_LIFE_SEC}), and a beat throws them up and open. One laid on a
 *   beat stays brighter, in `--ui-text-highlighted`. Redrawing snapshots,
 *   rather than fading a canvas into itself, keeps persistence exactly
 *   `dtSec`-driven: an 8-bit canvas faded by a fraction per frame keeps a ghost
 *   it can never round away, and fades at a rate set by the frame rate.
 *
 * Every array is made in `create`; a frame writes into them in place.
 */

/** Snapshot spacing and capacity: three seconds of history at most. */
const SNAPSHOT_SEC = 1 / 24
const CAPACITY = 72
/** An afterimage's life: in a quiet passage, and added at full heat. */
const MIN_LIFE_SEC = 0.3
const MAX_LIFE_SEC = 2.4
const AFTERIMAGE_ALPHA = 0.55
/** Below this an afterimage is not drawn at all. */
const AFTERIMAGE_FLOOR = 0.01
/** Rates per second: rise (× height), scroll (× width), widening (log). Each grows with the heat. */
const RISE = 0.05
const SCROLL = 0.06
const WIDEN = 0.5
const HEAT_RATE = 3
/** A beat throws the afterimages up and open. */
const PULSE_RISE = 0.35
const PULSE_WIDEN = 1.6
/** An afterimage laid on a beat this strong is drawn in `--ui-text-highlighted`. */
const BEAT_TRACE = 0.55

/** The ribbon's amplitude at full scale, as a fraction of the height. */
const AMPLITUDE = 0.26
/** The level's and the beat's share of the amplitude (the reader auto-scales; this puts loudness back). */
const LEVEL_AMPLITUDE = 1.1
const PULSE_AMPLITUDE = 0.6
/** Sway and tilt, as fractions of the height, and their periods in seconds. */
const SWAY = 0.08
const SWAY_PERIOD_SEC = 17
const TILT = 0.1
const TILT_PERIOD_SEC = 29
/** How far the ribbon climbs for a bright (high) spectrum and sinks for a dark one. */
const PITCH_LIFT = 0.3
/** The band's width (× shorter side) at rest and how much the level and the beat add. */
const BAND_WIDTH = 0.008
const BAND_LEVEL_WIDTH = 0.014
const BAND_ALPHA = 0.55
const CORE_ALPHA = 0.95

const POINTS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 96, auto: 160, high: 240 }

export function createTrace<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const points = POINTS_BY_QUALITY[quality]
  const reader = createWaveformReader(points)
  const drive = createDrive()
  const live = reader.points
  const shapes = new Float32Array(points * CAPACITY)
  /** Per afterimage, as fractions of the stage: centre, tilt, amplitude, rise, scroll; and life left (1 → 0), beat. */
  const centres = new Float32Array(CAPACITY)
  const tilts = new Float32Array(CAPACITY)
  const amplitudes = new Float32Array(CAPACITY)
  const rises = new Float32Array(CAPACITY)
  const scrolls = new Float32Array(CAPACITY)
  const lives = new Float32Array(CAPACITY)
  const strengths = new Float32Array(CAPACITY)

  let width = 0
  let height = 0
  let head = 0
  let sinceSnapshot = 0
  let swayPhase = 0
  let tiltPhase = 0

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
      const dt = dtSec > 0 ? dtSec : 0
      drive.update(audio, dt)
      const pulse = drive.pulse
      const heat = drive.heat

      swayPhase = (swayPhase + (dt / SWAY_PERIOD_SEC) * Math.PI * 2) % (Math.PI * 2)
      tiltPhase = (tiltPhase + (dt / TILT_PERIOD_SEC) * Math.PI * 2) % (Math.PI * 2)
      reader.read(audio.waveform, dt)

      // The afterimages move as one, by the drive as it is now.
      const pace = 1 + heat * HEAT_RATE
      const rise = (RISE * pace + pulse * PULSE_RISE) * dt
      const scroll = SCROLL * pace * dt
      const widen = Math.exp((WIDEN * pace + pulse * PULSE_WIDEN) * dt)
      const fade = dt / (MIN_LIFE_SEC + heat * heat * (MAX_LIFE_SEC - MIN_LIFE_SEC))
      for (let slot = 0; slot < CAPACITY; slot++) {
        if (lives[slot] <= 0) continue
        rises[slot] += rise
        scrolls[slot] += scroll
        amplitudes[slot] *= widen
        lives[slot] -= fade
      }

      // Positions are kept as fractions of the stage, so a resize keeps the history.
      const centre = 0.5 + Math.sin(swayPhase) * SWAY + (0.5 - drive.brightness) * PITCH_LIFT
      const tilt = Math.sin(tiltPhase) * TILT
      const amplitude = AMPLITUDE * (0.35 + audio.level * LEVEL_AMPLITUDE + pulse * PULSE_AMPLITUDE)
      sinceSnapshot += dt
      if (sinceSnapshot >= SNAPSHOT_SEC) {
        sinceSnapshot %= SNAPSHOT_SEC
        shapes.set(live, head * points)
        centres[head] = centre
        tilts[head] = tilt
        amplitudes[head] = amplitude
        rises[head] = 0
        scrolls[head] = 0
        lives[head] = 1
        strengths[head] = pulse
        head = (head + 1) % CAPACITY
      }
      if (width <= 0 || height <= 0 || points < 2) return

      const intensity = stage.intensity
      const short = width < height ? width : height
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // Afterimages, oldest first so the newest lie on top.
      ctx.lineWidth = Math.max(1, short * BAND_WIDTH * 0.5)
      for (let n = 0; n < CAPACITY; n++) {
        const slot = (head + n) % CAPACITY
        if (lives[slot] <= 0) continue
        const alpha = lives[slot] * lives[slot] * AFTERIMAGE_ALPHA
        const y = centres[slot] - rises[slot]
        if (alpha < AFTERIMAGE_FLOOR || y + amplitudes[slot] < -0.5 || scrolls[slot] > 1) {
          lives[slot] = 0
          continue
        }
        const beat = strengths[slot] >= BEAT_TRACE
        ctx.strokeStyle = palette.css[beat ? PaletteSlot.textHighlighted : PaletteSlot.accent]
        ctx.globalAlpha = Math.min(1, alpha * (0.6 + strengths[slot])) * intensity
        path(
          shapes,
          slot * points,
          y * height,
          tilts[slot] * height,
          amplitudes[slot] * height,
          scrolls[slot] * width
        )
        ctx.stroke()
      }

      // The ribbon now: a band, then its core.
      ctx.strokeStyle = palette.css[PaletteSlot.accent]
      ctx.globalAlpha = BAND_ALPHA * intensity
      ctx.lineWidth = Math.max(1, short * (BAND_WIDTH + (audio.level + pulse) * BAND_LEVEL_WIDTH))
      path(live, 0, centre * height, tilt * height, amplitude * height, 0)
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
