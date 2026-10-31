import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'
import { createDrive } from './drive'

/**
 * **Updraft** — W23-7: a few hundred motes drifting on a slowly changing swirl
 * of air, each leaving a short fading trail like smoke.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
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
 *   {@link TRAIL_STEP_SEC} of clamped time, drawn as segments bucketed by age —
 *   one stroke per age per colour, faint at the tail, bright at the mote.
 *
 * A mote that leaves the stage is reborn somewhere else on it with its trail
 * collapsed onto it, so it grows a new wisp rather than streaking across. The
 * births use a seeded xorshift, so a run is reproducible. Integration is in
 * substeps of at most {@link MAX_STEP_SEC}; every array is made in `create`.
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
const TRAIL = 16
const TRAIL_ALPHA = 0.5
/** The heat and the beat brighten the trails; the beat thickens them. */
const HEAT_ALPHA = 0.35
const PULSE_ALPHA = 0.35
const PULSE_WIDTH = 2
/** One mote in this many is drawn in `--ui-text-highlighted`, the rest in `--ui-primary`. */
const HIGHLIGHT_EVERY = 3

const MOTES_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 140, auto: 220, high: 320 }

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

export function createUpdraft<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const motes = MOTES_BY_QUALITY[quality]
  const posX = new Float32Array(motes)
  const posY = new Float32Array(motes)
  /** x, y per trail point, per mote; the ring's head is shared. */
  const trails = new Float32Array(motes * TRAIL * 2)
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
    const speed = (BASE_SPEED + level * LEVEL_SPEED) * (1 + heat * HEAT_SPEED)
    for (let mote = 0; mote < motes; mote++) {
      const x = posX[mote]
      const y = posY[mote]
      flowVelocity(x, y, time, velocity)
      let vx = velocity[0] * speed
      let vy = velocity[1] * speed - rise
      const r = Math.sqrt(x * x + y * y)
      if (r > 1e-4) {
        // Tangential round the centre (bass), radial out from it (onsets).
        const swirl = (VORTEX * bass) / (r + VORTEX_CORE)
        const push = PUFF * pulse
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

  /** Path every mote's segment of one age; `highlight` picks which motes. */
  function segments(age: number, highlight: boolean, cx: number, cy: number, unit: number): void {
    ctx.beginPath()
    // Logical point `age` (0 = oldest) to the next, or to the mote itself for the newest.
    const from = (head + age) % TRAIL
    const to = (head + age + 1) % TRAIL
    const newest = age === TRAIL - 1
    for (let mote = 0; mote < motes; mote++) {
      if ((mote % HIGHLIGHT_EVERY === 0) !== highlight) continue
      const a = (mote * TRAIL + from) * 2
      const x1 = newest ? posX[mote] : trails[(mote * TRAIL + to) * 2]
      const y1 = newest ? posY[mote] : trails[(mote * TRAIL + to) * 2 + 1]
      ctx.moveTo(cx + trails[a] * unit, cy + trails[a + 1] * unit)
      ctx.lineTo(cx + x1 * unit, cy + y1 * unit)
    }
  }

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
      const short = width < height ? width : height
      if (short > 0) {
        halfX = width / short / 2
        halfY = height / short / 2
      }
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.clearRect(0, 0, width, height)

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

      const intensity = stage.intensity
      const unit = width < height ? width : height
      const cx = width / 2
      const cy = height / 2
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, unit * 0.0025 * (1 + pulse * PULSE_WIDTH))
      const glow = Math.min(1.6, 1 + heat * HEAT_ALPHA + pulse * PULSE_ALPHA)

      for (let age = 0; age < TRAIL; age++) {
        const strength = (age + 1) / TRAIL
        ctx.globalAlpha =
          Math.min(1, strength * Math.sqrt(strength) * TRAIL_ALPHA * glow) * intensity
        ctx.strokeStyle = palette.css[PaletteSlot.accent]
        segments(age, false, cx, cy, unit)
        ctx.stroke()
        ctx.strokeStyle = palette.css[PaletteSlot.textHighlighted]
        segments(age, true, cx, cy, unit)
        ctx.stroke()
      }

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}
