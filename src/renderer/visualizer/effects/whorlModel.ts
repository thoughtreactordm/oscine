import type { AnalysisFrame } from '../analysisFrame'
import { multiplierParam, resolveParams, type EffectParamSpec, type EffectParams } from '../params'
import { follow, type Quality2D } from './draw2d'
import { createDrive } from './drive'
import { createWaveformReader } from './waveform'

/**
 * **Whorl**'s tunnel, without the drawing — W23-7, moved to the WebGL2 tier by
 * W23-16 (`whorl.ts` draws it).
 *
 * The waveform as a ring at the centre, leaving a tunnel of its past selves
 * that rush outward and twist as the song picks up.
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
 * Why it left the 2D tier: up to 150 wide anti-aliased strokes a frame, the
 * outer ones stage-sized, measured ~28 ms of raster a frame at 1440p on either
 * 2D backend — a ceiling on how often the canvas could update, before the
 * flash guard's read made it worse. As one instanced draw it costs the GPU
 * next to nothing.
 *
 * Each frame `update` fills {@link WhorlModel.instances}: one record of
 * {@link INSTANCE_FLOATS} per stroke, oldest (outermost) ring first, then the
 * live ring's band and core. All in pixels of the target, y down, centred on
 * the target's middle. Every array is made here, once.
 */

const SNAPSHOT_SEC = 1 / 15
/** Ten seconds of rings at most. */
export const CAPACITY = 150
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
const CORE_WIDTH = 0.0022
const TAU = Math.PI * 2

const POINTS_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 72, auto: 128, high: 192 }

/** Which palette entry a stroke takes. */
export const WhorlColour = { accent: 0, highlighted: 1 } as const

/**
 * One stroke: `radius`, `swing` (px the shape's ±1 swings it), `turn` (rad),
 * the shape's `row` in {@link WhorlModel.shapes}, `lineWidth` (px), `alpha`
 * (with the flash guard's intensity in it), a {@link WhorlColour}, and a pad
 * to keep the record two `vec4`s.
 */
export const INSTANCE_FLOATS = 8
/** Every past ring, plus the live ring drawn twice (band and core). */
export const MAX_INSTANCES = CAPACITY + 2

/** Knobs scale the ring's size, spin, tunnel speed, trail life, and line weight. */
export const WHORL_KNOBS: readonly EffectParamSpec[] = [
  multiplierParam('size', 'Size', 'How large the ring and its swing are.', { min: 0.5, max: 1.75 }),
  multiplierParam('spin', 'Spin', 'How fast the ring spins.', { min: 0, max: 3 }),
  multiplierParam('tunnel', 'Tunnel speed', 'How fast past rings rush outward and twist.', {
    min: 0,
    max: 3
  }),
  // Max 1.25: a full-heat trail then lasts exactly as long as the ring buffer holds.
  multiplierParam('trail', 'Trail length', 'How long past rings stay visible.', {
    min: 0.25,
    max: 1.25
  }),
  multiplierParam('weight', 'Line weight', 'How thick the ring and its tunnel are.', {
    min: 0.25,
    max: 3
  })
]

export interface WhorlModel {
  /** Points per ring. */
  readonly points: number
  /** {@link CAPACITY} past rings, then the live one. */
  readonly rows: number
  /** Ring shapes, `points` per row, in −1..1. The last row is the live ring. */
  readonly shapes: Float32Array
  /** The row `update` snapshotted into, or −1. The live row changes every frame. */
  readonly snapshotRow: number
  /** {@link INSTANCE_FLOATS} per stroke, drawing order. */
  readonly instances: Float32Array
  /** Strokes to draw this frame. */
  readonly count: number
  update(audio: AnalysisFrame, intensity: number, width: number, height: number, dt: number): void
}

export function createWhorlModel(
  quality: Quality2D,
  knobs: EffectParams = resolveParams(WHORL_KNOBS, undefined)
): WhorlModel {
  const points = POINTS_BY_QUALITY[quality]
  const rows = CAPACITY + 1
  const liveRow = CAPACITY
  const reader = createWaveformReader(points)
  const drive = createDrive()
  const live = reader.points
  const shapes = new Float32Array(points * rows)
  const instances = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS)
  /** Per ring: radius, swing (px at scale 1), scale, turn, life left (1 → 0), beat strength. */
  const radii = new Float32Array(CAPACITY)
  const swings = new Float32Array(CAPACITY)
  const scales = new Float32Array(CAPACITY)
  const turns = new Float32Array(CAPACITY)
  const lives = new Float32Array(CAPACITY)
  const strengths = new Float32Array(CAPACITY)

  let head = 0
  let sinceSnapshot = 0
  let spin = 0
  let spinSpeed = SPIN * knobs.spin
  let snapshotRow = -1
  let count = 0

  function push(
    radius: number,
    swing: number,
    turn: number,
    row: number,
    lineWidth: number,
    alpha: number,
    colour: number
  ): void {
    const at = count * INSTANCE_FLOATS
    instances[at] = radius
    instances[at + 1] = swing
    instances[at + 2] = turn
    instances[at + 3] = row
    instances[at + 4] = lineWidth
    instances[at + 5] = alpha
    instances[at + 6] = colour
    instances[at + 7] = 0
    count++
  }

  return {
    points,
    rows,
    shapes,
    instances,
    get snapshotRow() {
      return snapshotRow
    },
    get count() {
      return count
    },

    update(audio, intensity, width, height, dtSec) {
      count = 0
      snapshotRow = -1
      const dt = dtSec > 0 ? dtSec : 0
      drive.update(audio, dt)
      const pulse = drive.pulse
      const heat = drive.heat
      reader.read(audio.waveform, dt)
      shapes.set(live, liveRow * points)

      const target = (SPIN + audio.bass * BASS_SPIN + heat * HEAT_SPIN) * knobs.spin
      spinSpeed += (target - spinSpeed) * follow(dt, SPIN_TAU_SEC)
      spin = (spin + spinSpeed * dt) % TAU

      // The tunnel moves as one, by the drive as it is now.
      const grow = Math.exp(
        (GROW * knobs.tunnel + heat * GROW_HEAT * knobs.tunnel + pulse * GROW_PULSE) * dt
      )
      const twist =
        (TWIST * knobs.tunnel +
          heat * TWIST_HEAT * knobs.tunnel +
          (drive.brightness - 0.5) * TWIST_BRIGHTNESS) *
        dt
      const fade = dt / ((MIN_LIFE_SEC + heat * heat * (MAX_LIFE_SEC - MIN_LIFE_SEC)) * knobs.trail)
      for (let slot = 0; slot < CAPACITY; slot++) {
        if (lives[slot] <= 0) continue
        scales[slot] *= grow
        turns[slot] += twist
        lives[slot] -= fade
      }

      const short = width < height ? width : height
      const radius = short * RADIUS * (1 + pulse * PULSE_SWELL + heat * HEAT_SWELL) * knobs.size
      const swing =
        short * SWING * (0.35 + audio.level * LEVEL_SWING + pulse * PULSE_SWING) * knobs.size
      sinceSnapshot += dt
      if (sinceSnapshot >= SNAPSHOT_SEC) {
        sinceSnapshot %= SNAPSHOT_SEC
        shapes.set(live, head * points)
        snapshotRow = head
        radii[head] = radius
        swings[head] = swing
        scales[head] = 1
        turns[head] = spin
        lives[head] = 1
        strengths[head] = pulse
        head = (head + 1) % CAPACITY
      }
      if (width <= 0 || height <= 0) return

      const cx = width / 2
      const cy = height / 2
      /** A ring whose inner edge is past the corners is off the stage. */
      const reach = Math.sqrt(cx * cx + cy * cy)
      const baseWidth = Math.max(1, short * BAND_WIDTH * 0.4 * knobs.weight)

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
        push(
          r,
          s,
          turns[slot],
          slot,
          // Nearer rings are thicker, as they would be down a tunnel.
          Math.min(baseWidth * 6, baseWidth * Math.sqrt(scale)),
          Math.min(1, alpha * (0.6 + strengths[slot])) * intensity,
          beat ? WhorlColour.highlighted : WhorlColour.accent
        )
      }

      // The ring now: a wide band, and a fine bright core along it.
      push(
        radius,
        swing,
        spin,
        liveRow,
        Math.max(1, short * (BAND_WIDTH + (audio.level + pulse) * BAND_LEVEL_WIDTH) * knobs.weight),
        BAND_ALPHA * intensity,
        WhorlColour.accent
      )
      push(
        radius,
        swing,
        spin,
        liveRow,
        Math.max(1, short * CORE_WIDTH),
        CORE_ALPHA * intensity,
        WhorlColour.highlighted
      )
    }
  }
}
