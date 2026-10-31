import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'
import { createWaveformReader } from './waveform'

/**
 * **Whorl** — W23-7: Trace wrapped into a circle. The waveform is a closed ring
 * around the centre; each afterimage expands outward and turns a little
 * further than the last, so the history leaves a spiral of fading rings.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
 *
 * - **The ring** is the shared waveform reader's shape (triggered, auto-scaled,
 *   tapered, so the seam sits at the base radius) laid around the circle as a
 *   radial offset. It spins: slowly at rest, faster with the bass. It is a
 *   wide `--ui-primary` band under a thin `--ui-text-highlighted` core.
 * - **The afterimages** are earlier rings, a snapshot every
 *   {@link SNAPSHOT_SEC} of clamped time, each redrawn at `e^(−age/τ)`, grown
 *   by its age and turned by its age on top of the spin it was taken at — the
 *   same snapshot ring Trace uses, so persistence is exactly `dtSec`-driven.
 *
 * Every array is made in `create`; the angle tables too.
 */

const SNAPSHOT_SEC = 1 / 20
const SNAPSHOTS = 26
const AFTERIMAGE_TAU_SEC = 0.42
const AFTERIMAGE_ALPHA = 0.55
const AFTERIMAGE_FLOOR = 0.01
/** Per second of age: growth (× base radius) and extra turn (radians). */
const EXPAND = 0.9
const TWIST = 0.9

/** The ring's base radius and the waveform's swing, as fractions of the shorter side. */
const RADIUS = 0.17
const SWING = 0.09
/** Radians per second of spin at rest, and added at full bass. */
const SPIN = 0.25
const BASS_SPIN = 1.6
/** How quickly the spin follows the bass. */
const SPIN_TAU_SEC = 0.35
const BAND_WIDTH = 0.007
const BAND_LEVEL_WIDTH = 0.01
const BAND_ALPHA = 0.5
const CORE_ALPHA = 0.9
const TAU = Math.PI * 2

const POINTS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 96, auto: 160, high: 240 }

export function createWhorl<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const points = POINTS_BY_QUALITY[quality]
  const reader = createWaveformReader(points)
  const live = reader.points
  const cos = new Float32Array(points)
  const sin = new Float32Array(points)
  for (let point = 0; point < points; point++) {
    const angle = (point / points) * TAU
    cos[point] = Math.cos(angle)
    sin[point] = Math.sin(angle)
  }
  const shapes = new Float32Array(points * SNAPSHOTS)
  const turns = new Float32Array(SNAPSHOTS)
  const ages = new Float32Array(SNAPSHOTS).fill(Infinity)

  let width = 0
  let height = 0
  let head = 0
  let sinceSnapshot = 0
  let spin = 0
  let spinSpeed = SPIN

  /** Trace one closed ring; the caller strokes it. */
  function ring(
    source: Float32Array,
    offset: number,
    cx: number,
    cy: number,
    radius: number,
    swing: number,
    turn: number
  ): void {
    const turnCos = Math.cos(turn)
    const turnSin = Math.sin(turn)
    ctx.beginPath()
    for (let point = 0; point < points; point++) {
      const r = radius + source[offset + point] * swing
      const dirX = cos[point] * turnCos - sin[point] * turnSin
      const dirY = sin[point] * turnCos + cos[point] * turnSin
      if (point === 0) ctx.moveTo(cx + dirX * r, cy + dirY * r)
      else ctx.lineTo(cx + dirX * r, cy + dirY * r)
    }
    ctx.closePath()
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.clearRect(0, 0, width, height)

      spinSpeed += (SPIN + audio.bass * BASS_SPIN - spinSpeed) * follow(dtSec, SPIN_TAU_SEC)
      spin = (spin + spinSpeed * dtSec) % TAU
      for (let slot = 0; slot < SNAPSHOTS; slot++) ages[slot] += dtSec
      reader.read(audio.waveform, dtSec)
      sinceSnapshot += dtSec
      if (sinceSnapshot >= SNAPSHOT_SEC) {
        sinceSnapshot %= SNAPSHOT_SEC
        shapes.set(live, head * points)
        turns[head] = spin
        ages[head] = 0
        head = (head + 1) % SNAPSHOTS
      }
      if (width <= 0 || height <= 0) return

      const intensity = stage.intensity
      const short = width < height ? width : height
      const cx = width / 2
      const cy = height / 2
      const radius = short * RADIUS
      const swing = short * SWING
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // Afterimages, oldest (outermost) first.
      ctx.strokeStyle = palette.css[PaletteSlot.accent]
      ctx.lineWidth = Math.max(1, short * BAND_WIDTH * 0.45)
      for (let n = 0; n < SNAPSHOTS; n++) {
        const slot = (head + n) % SNAPSHOTS
        const age = ages[slot]
        const fade = Math.exp(-age / AFTERIMAGE_TAU_SEC) * AFTERIMAGE_ALPHA
        if (!(fade >= AFTERIMAGE_FLOOR)) continue
        const grow = 1 + age * EXPAND
        ctx.globalAlpha = fade * intensity
        ring(shapes, slot * points, cx, cy, radius * grow, swing * grow, turns[slot] + age * TWIST)
        ctx.stroke()
      }

      // The ring now.
      ctx.globalAlpha = BAND_ALPHA * intensity
      ctx.lineWidth = Math.max(1, short * (BAND_WIDTH + audio.level * BAND_LEVEL_WIDTH))
      ring(live, 0, cx, cy, radius, swing, spin)
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
