import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'
import { createDrive } from './drive'
import { createWaveformReader } from './waveform'

/**
 * **Whorl** — W23-7: the waveform as a ring at the centre, leaving a tunnel of
 * its past selves that rush outward and twist as the song picks up.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
 *
 * - **The ring** is the shared waveform reader's shape laid round a circle. It
 *   swells on the beat, its swing follows the level (the reader auto-scales, so
 *   loudness is put back here), and it spins faster with the bass and the heat.
 * - **The tunnel.** Every {@link SNAPSHOT_SEC} the ring is copied into a ring
 *   buffer of up to {@link CAPACITY} past rings. Each keeps its own scale, turn
 *   and fade, integrated every frame from the drive as it is *now*, so the
 *   whole tunnel answers the music at once:
 *   - it grows exponentially (perspective — rings speed up as they near the
 *     viewer), faster with the heat and surging on every beat;
 *   - it twists, faster with the heat, the way the brightness leans;
 *   - it fades over a lifetime that runs from well under a second in a quiet
 *     passage to {@link MAX_LIFE_SEC} when the song is going hard, so a build
 *     fills the stage with rings.
 *   A ring laid on a beat is drawn brighter, in `--ui-text-highlighted`, all
 *   the way out. Rings are dropped once they leave the stage or fade out.
 *
 * Every array is made in `create`; the angle tables too.
 */

const SNAPSHOT_SEC = 1 / 15
/** Ten seconds of rings at most. */
const CAPACITY = 150
/** A ring's life: in a quiet passage, and added at full heat. */
const MIN_LIFE_SEC = 0.6
const MAX_LIFE_SEC = 8
const RING_ALPHA = 0.6
const RING_FLOOR = 0.012
/** Growth per second (log scale): at rest, at full heat, and the surge at a full beat. */
const GROW = 0.12
const GROW_HEAT = 0.28
const GROW_PULSE = 0.9
/** Twist (rad/s): at rest, at full heat, and how far the brightness leans it either way. */
const TWIST = 0.12
const TWIST_HEAT = 0.5
const TWIST_BRIGHTNESS = 0.9
/** A beat ring: strength at least this marks it, and its brightness boost. */
const BEAT_RING = 0.55

/** The ring's base radius and the waveform's swing, as fractions of the shorter side. */
const RADIUS = 0.15
const SWING = 0.11
/** The level's and the beat's share of the swing; the beat's swell of the radius; the heat's. */
const LEVEL_SWING = 1.2
const PULSE_SWING = 0.7
const PULSE_SWELL = 0.45
const HEAT_SWELL = 0.15
/** Radians per second of spin: at rest, at full bass, at full heat. */
const SPIN = 0.25
const BASS_SPIN = 1.8
const HEAT_SPIN = 1.2
const SPIN_TAU_SEC = 0.3
const BAND_WIDTH = 0.007
const BAND_LEVEL_WIDTH = 0.012
const BAND_ALPHA = 0.55
const CORE_ALPHA = 0.95
const TAU = Math.PI * 2

const POINTS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 72, auto: 128, high: 192 }

export function createWhorl<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const points = POINTS_BY_QUALITY[quality]
  const reader = createWaveformReader(points)
  const drive = createDrive()
  const live = reader.points
  const cos = new Float32Array(points)
  const sin = new Float32Array(points)
  for (let point = 0; point < points; point++) {
    const angle = (point / points) * TAU
    cos[point] = Math.cos(angle)
    sin[point] = Math.sin(angle)
  }
  const shapes = new Float32Array(points * CAPACITY)
  /** Per ring: radius, swing (px at scale 1), scale, turn, life left (1 → 0), beat strength. */
  const radii = new Float32Array(CAPACITY)
  const swings = new Float32Array(CAPACITY)
  const scales = new Float32Array(CAPACITY)
  const turns = new Float32Array(CAPACITY)
  const lives = new Float32Array(CAPACITY)
  const strengths = new Float32Array(CAPACITY)

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
      const dt = dtSec > 0 ? dtSec : 0
      drive.update(audio, dt)
      const pulse = drive.pulse
      const heat = drive.heat
      reader.read(audio.waveform, dt)

      const target = SPIN + audio.bass * BASS_SPIN + heat * HEAT_SPIN
      spinSpeed += (target - spinSpeed) * follow(dt, SPIN_TAU_SEC)
      spin = (spin + spinSpeed * dt) % TAU

      // The tunnel moves as one, by the drive as it is now.
      const grow = Math.exp((GROW + heat * GROW_HEAT + pulse * GROW_PULSE) * dt)
      const twist = (TWIST + heat * TWIST_HEAT + (drive.brightness - 0.5) * TWIST_BRIGHTNESS) * dt
      const fade = dt / (MIN_LIFE_SEC + heat * heat * (MAX_LIFE_SEC - MIN_LIFE_SEC))
      for (let slot = 0; slot < CAPACITY; slot++) {
        if (lives[slot] <= 0) continue
        scales[slot] *= grow
        turns[slot] += twist
        lives[slot] -= fade
      }

      const short = width < height ? width : height
      const radius = short * RADIUS * (1 + pulse * PULSE_SWELL + heat * HEAT_SWELL)
      const swing = short * SWING * (0.35 + audio.level * LEVEL_SWING + pulse * PULSE_SWING)
      sinceSnapshot += dt
      if (sinceSnapshot >= SNAPSHOT_SEC) {
        sinceSnapshot %= SNAPSHOT_SEC
        shapes.set(live, head * points)
        radii[head] = radius
        swings[head] = swing
        scales[head] = 1
        turns[head] = spin
        lives[head] = 1
        strengths[head] = pulse
        head = (head + 1) % CAPACITY
      }
      if (width <= 0 || height <= 0) return

      const intensity = stage.intensity
      const cx = width / 2
      const cy = height / 2
      /** A ring whose inner edge is past the corners is off the stage. */
      const reach = Math.sqrt(cx * cx + cy * cy)
      const baseWidth = Math.max(1, short * BAND_WIDTH * 0.4)
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // The tunnel, oldest (outermost) first.
      for (let n = 0; n < CAPACITY; n++) {
        const slot = (head + n) % CAPACITY
        if (lives[slot] <= 0) continue
        const scale = scales[slot]
        const r = radii[slot] * scale
        const s = swings[slot] * scale
        const alpha = lives[slot] * lives[slot] * RING_ALPHA
        if (alpha < RING_FLOOR || r - s > reach) {
          lives[slot] = 0
          continue
        }
        const beat = strengths[slot] >= BEAT_RING
        ctx.strokeStyle = palette.css[beat ? PaletteSlot.textHighlighted : PaletteSlot.accent]
        ctx.globalAlpha = Math.min(1, alpha * (0.6 + strengths[slot])) * intensity
        // Nearer rings are thicker, as they would be down a tunnel.
        ctx.lineWidth = Math.min(baseWidth * 6, baseWidth * Math.sqrt(scale))
        ring(shapes, slot * points, cx, cy, r, s, turns[slot])
        ctx.stroke()
      }

      // The ring now.
      ctx.strokeStyle = palette.css[PaletteSlot.accent]
      ctx.globalAlpha = BAND_ALPHA * intensity
      ctx.lineWidth = Math.max(1, short * (BAND_WIDTH + (audio.level + pulse) * BAND_LEVEL_WIDTH))
      ring(live, 0, cx, cy, radius, swing, spin)
      ctx.stroke()
      ctx.globalAlpha = CORE_ALPHA * intensity
      ctx.strokeStyle = palette.css[PaletteSlot.textHighlighted]
      ctx.lineWidth = Math.max(1, short * 0.0022)
      ctx.stroke()

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}
