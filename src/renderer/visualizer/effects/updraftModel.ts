import type { AnalysisFrame } from '../analysisFrame'
import { multiplierParam, resolveParams, type EffectParamSpec, type EffectParams } from '../params'
import { follow, type Quality2D } from './draw2d'
import { createDrive } from './drive'
import { StrokeColour } from './strokes'

/**
 * **Updraft**'s air and motes, without the drawing — W23-7, moved to the WebGL2
 * tier by W23-16 (`updraft.ts` draws it).
 *
 * A few hundred motes drifting on a slowly changing swirl of air, each leaving
 * a short fading trail like smoke.
 *
 * - **The air** is the curl of a sum-of-sines stream function that drifts in
 *   time ({@link flowVelocity}): divergence-free, so motes swirl and never
 *   bunch into sinks, and analytic, so it costs a few `sin`s per mote.
 * - **The music**: the level and the heat set how fast the air moves; the
 *   bass stirs a vortex round the centre; every beat bursts the motes outward
 *   from it (the drive's pulse, so a push that decays rather than a jump) and
 *   thickens and brightens the trails. The brightness (pitch) sets the draft:
 *   a bright passage rises, a bass-heavy one sinks.
 * - **The trails** are a ring of positions every mote shares, laid at a fixed
 *   {@link TRAIL_STEP_SEC} of clamped time, drawn as one segment per mote per
 *   age — faint at the tail, bright at the mote.
 *
 * A mote that leaves the stage is reborn somewhere else on it with its trail
 * collapsed onto it, so it grows a new wisp rather than streaking across. The
 * births use a seeded xorshift, so a run is reproducible. Integration is in
 * substeps of at most {@link MAX_STEP_SEC}; every array is made here, once.
 *
 * Why it left the 2D tier: ~3,500 round-capped segments a frame measured
 * ~14 ms of 2D raster at 1440p, with spikes past 24 ms.
 *
 * Each frame `update` fills {@link UpdraftModel.instances} with
 * {@link SEGMENT_FLOATS} per segment — `(x0, y0, x1, y1)` and
 * `(lineWidth, alpha, colour, 0)`, pixels of the target, y down — in the 2D
 * version's order: oldest age first, and within an age the `--ui-primary`
 * motes before the `--ui-text-highlighted` ones.
 */

/** Positions are in units of the stage's shorter side, from its centre. */
const FLOW_SPEED = 0.05
/** The draft (units/s upward) at the darkest spectrum and added at the brightest: bass sinks, treble rises. */
const RISE_FLOOR = -0.04
const RISE_BRIGHTNESS = 0.2
const LEVEL_SPEED = 3.5
const BASE_SPEED = 0.45
/** The heat multiplies every speed by up to this much more. */
const HEAT_SPEED = 1.5
/** The bass vortex: tangential speed at full bass, and the core radius that keeps it finite. */
const VORTEX = 0.3
const VORTEX_CORE = 0.12
/** The beat's puff: outward speed at a full pulse. */
const PUFF = 1.1
const ENERGY_TAU_SEC = 0.25
/** How far past the edge a mote may drift before it is reborn. */
const MARGIN = 0.08
const MAX_STEP_SEC = 1 / 60
const TRAIL_STEP_SEC = 1 / 24
export const TRAIL = 16
const TRAIL_ALPHA = 0.5
/** The heat and the beat brighten the trails; the beat thickens them. */
const HEAT_ALPHA = 0.35
const PULSE_ALPHA = 0.35
const PULSE_WIDTH = 2
const LINE_WIDTH = 0.0025
/** One mote in this many is drawn in `--ui-text-highlighted`, the rest in `--ui-primary`. */
export const HIGHLIGHT_EVERY = 3

const MOTES_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 140, auto: 220, high: 320 }

/** Floats per segment: two endpoints, then width, alpha, colour and a pad. */
export const SEGMENT_FLOATS = 8

/** Scales mote speed, the swirl, the beat's burst, and trail brightness. */
export const UPDRAFT_KNOBS: readonly EffectParamSpec[] = [
  multiplierParam('speed', 'Mote speed', 'How fast the motes drift.', { min: 0.25, max: 3 }),
  multiplierParam('swirl', 'Swirl', 'How strongly the motes curl and spin.', { min: 0, max: 3 }),
  multiplierParam(
    'burst',
    'Beat burst',
    'How hard a beat throws the motes out and flares their trails.',
    { min: 0, max: 2 }
  ),
  multiplierParam('trail', 'Trail brightness', 'How bright the smoke trails are.', {
    min: 0.25,
    max: 1.75
  })
]

/**
 * The air's velocity at `(x, y)` and time `t`: the curl `(∂ψ/∂y, −∂ψ/∂x)` of
 * `ψ = sin(1.9x + .21t)·cos(1.6y − .17t) + .6·sin(2.7y + 1.3x + .13t + 1)`,
 * scaled by {@link FLOW_SPEED}. Written into `out[0..1]`.
 */
export function flowVelocity(x: number, y: number, t: number, out: Float64Array): void {
  const a = 1.9 * x + 0.21 * t
  const b = 1.6 * y - 0.17 * t
  const c = 2.7 * y + 1.3 * x + 0.13 * t + 1
  const cosC = Math.cos(c)
  out[0] = FLOW_SPEED * (-1.6 * Math.sin(a) * Math.sin(b) + 0.6 * 2.7 * cosC)
  out[1] = -FLOW_SPEED * (1.9 * Math.cos(a) * Math.cos(b) + 0.6 * 1.3 * cosC)
}

export interface UpdraftModel {
  /** Motes at this quality. */
  readonly motes: number
  /** The most segments a frame can hold: one per mote per trail age. */
  readonly maxSegments: number
  /** {@link SEGMENT_FLOATS} per segment, drawing order. */
  readonly instances: Float32Array
  /** Segments to draw this frame. */
  readonly count: number
  /** Set the stage's aspect (and so where motes may roam). Call on every resize. */
  resize(width: number, height: number): void
  update(audio: AnalysisFrame, intensity: number, dt: number): void
}

export function createUpdraftModel(
  quality: Quality2D,
  knobs: EffectParams = resolveParams(UPDRAFT_KNOBS, undefined)
): UpdraftModel {
  const motes = MOTES_BY_QUALITY[quality]
  const maxSegments = motes * TRAIL
  const posX = new Float32Array(motes)
  const posY = new Float32Array(motes)
  /** x, y per trail point, per mote; the ring's head is shared. */
  const trails = new Float32Array(motes * TRAIL * 2)
  const instances = new Float32Array(maxSegments * SEGMENT_FLOATS)
  const velocity = new Float64Array(2)

  let width = 0
  let height = 0
  let halfX = 0.5
  let halfY = 0.5
  let seed = 0x2545f491
  let time = 0
  let carry = 0
  let head = 0
  let level = 0
  let bass = 0
  let heat = 0
  let pulse = 0
  let rise = 0
  let count = 0
  const drive = createDrive()

  function random(): number {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }

  function rebirth(mote: number): void {
    const x = (random() * 2 - 1) * halfX
    const y = (random() * 2 - 1) * halfY
    posX[mote] = x
    posY[mote] = y
    for (let point = 0; point < TRAIL; point++) {
      const at = (mote * TRAIL + point) * 2
      trails[at] = x
      trails[at + 1] = y
    }
  }

  for (let mote = 0; mote < motes; mote++) rebirth(mote)

  function advance(dtSec: number): void {
    const speed =
      (BASE_SPEED * knobs.speed + level * LEVEL_SPEED * knobs.speed) * (1 + heat * HEAT_SPEED)
    for (let mote = 0; mote < motes; mote++) {
      const x = posX[mote]
      const y = posY[mote]
      flowVelocity(x, y, time, velocity)
      // flowVelocity bakes in FLOW_SPEED; the swirl knob scales that field here.
      let vx = velocity[0] * knobs.swirl * speed
      let vy = velocity[1] * knobs.swirl * speed - rise
      const r = Math.sqrt(x * x + y * y)
      if (r > 1e-4) {
        // Tangential round the centre (bass), radial out from it (onsets).
        const swirl = (VORTEX * knobs.swirl * bass) / (r + VORTEX_CORE)
        const push = PUFF * knobs.burst * pulse
        vx += (-y / r) * swirl + (x / r) * push
        vy += (x / r) * swirl + (y / r) * push
      }
      const nx = x + vx * dtSec
      const ny = y + vy * dtSec
      if (
        nx < -halfX - MARGIN ||
        nx > halfX + MARGIN ||
        ny < -halfY - MARGIN ||
        ny > halfY + MARGIN
      ) {
        rebirth(mote)
      } else {
        posX[mote] = nx
        posY[mote] = ny
      }
    }
    time += dtSec
  }

  function layTrail(): void {
    for (let mote = 0; mote < motes; mote++) {
      const at = (mote * TRAIL + head) * 2
      trails[at] = posX[mote]
      trails[at + 1] = posY[mote]
    }
    head = (head + 1) % TRAIL
  }

  /** Every mote's segment of one age; `highlight` picks which motes. */
  function segments(
    age: number,
    highlight: boolean,
    cx: number,
    cy: number,
    unit: number,
    lineWidth: number,
    alpha: number
  ): void {
    // Logical point `age` (0 = oldest) to the next, or to the mote itself for the newest.
    const from = (head + age) % TRAIL
    const to = (head + age + 1) % TRAIL
    const newest = age === TRAIL - 1
    const colour = highlight ? StrokeColour.highlighted : StrokeColour.accent
    for (let mote = 0; mote < motes; mote++) {
      if ((mote % HIGHLIGHT_EVERY === 0) !== highlight) continue
      const a = (mote * TRAIL + from) * 2
      const x1 = newest ? posX[mote] : trails[(mote * TRAIL + to) * 2]
      const y1 = newest ? posY[mote] : trails[(mote * TRAIL + to) * 2 + 1]
      const at = count * SEGMENT_FLOATS
      instances[at] = cx + trails[a] * unit
      instances[at + 1] = cy + trails[a + 1] * unit
      instances[at + 2] = cx + x1 * unit
      instances[at + 3] = cy + y1 * unit
      instances[at + 4] = lineWidth
      instances[at + 5] = alpha
      instances[at + 6] = colour
      instances[at + 7] = 0
      count++
    }
  }

  return {
    motes,
    maxSegments,
    instances,
    get count() {
      return count
    },

    resize(nextWidth, nextHeight) {
      width = nextWidth
      height = nextHeight
      const short = width < height ? width : height
      if (short > 0) {
        halfX = width / short / 2
        halfY = height / short / 2
      }
    },

    update(audio, intensity, dtSec) {
      count = 0
      const dt = dtSec > 0 ? dtSec : 0
      const energyFollow = follow(dt, ENERGY_TAU_SEC)
      level += (audio.level - level) * energyFollow
      bass += (audio.bass - bass) * energyFollow
      drive.update(audio, dt)
      pulse = drive.pulse
      heat = drive.heat
      rise = RISE_FLOOR + drive.brightness * RISE_BRIGHTNESS
      const steps = Math.ceil(dt / MAX_STEP_SEC)
      for (let n = 0; n < steps; n++) {
        advance(dt / steps)
        carry += dt / steps
        if (carry >= TRAIL_STEP_SEC) {
          carry -= TRAIL_STEP_SEC
          layTrail()
        }
      }
      if (width <= 0 || height <= 0) return

      const unit = width < height ? width : height
      const cx = width / 2
      const cy = height / 2
      const lineWidth = Math.max(1, unit * LINE_WIDTH * (1 + pulse * PULSE_WIDTH * knobs.burst))
      const glow = Math.min(
        1.6,
        1 + heat * HEAT_ALPHA * knobs.trail + pulse * PULSE_ALPHA * knobs.burst
      )

      for (let age = 0; age < TRAIL; age++) {
        const strength = (age + 1) / TRAIL
        const alpha =
          Math.min(1, strength * Math.sqrt(strength) * TRAIL_ALPHA * knobs.trail * glow) * intensity
        segments(age, false, cx, cy, unit, lineWidth, alpha)
        segments(age, true, cx, cy, unit, lineWidth, alpha)
      }
    }
  }
}
