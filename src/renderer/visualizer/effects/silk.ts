import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette, type PaletteSlotId } from '../palette'
import { follow, type Draw2D, type Effect2DInstance, type Quality2D, type Stage2D } from './draw2d'
import { createDrive, spectralCentroid } from './drive'

/**
 * **Silk** — W23-7: a few long threads, each drawn by a pen swinging on two
 * pendulums per axis, whose rates drift with the bass, the mids and the
 * treble. Each keeps a long fading tail, so the figures loop, unravel and
 * re-form; the whole figure turns slowly.
 *
 * 2D, `overlay`. The host lays it over the wash and scales it by emergence; this
 * multiplies only by the flash guard's intensity (D35.8).
 *
 * - **The pens.** Thread `t`'s pen is `x = Σ wᵢ sin φᵢ`, `y = Σ wᵢ sin ψᵢ`. Its
 *   phases are integrated, not evaluated, so a rate change bends the figure
 *   rather than jumping it. Each thread's rates are scaled hard by one smoothed
 *   band energy — bass, mid, treble — so a bass line reshapes one thread and a
 *   hi-hat another, and all of them by the brightness (pitch): a high melody
 *   quickens every pen, a low one slows them. An onset plucks the pens well
 *   outward; the level breathes the figure's size. Both are baked in when a point is laid, so a pluck travels
 *   down the tail rather than shaking the whole thread.
 * - **The tails** are laid at a fixed {@link STEP_SEC} of clamped time into a
 *   ring per thread, so their shape is frame-rate independent, and drawn in
 *   {@link BUCKETS} runs from faint (oldest) to bright (newest): one stroke per
 *   run, no per-segment state changes.
 *
 * - **The drive** acts at draw time: the heat opens the figure up and spins it
 *   faster; a beat thickens the threads and flares the pens.
 *
 * The rings are filled in `create` (the pens are run for a whole tail first),
 * so a thread is whole when the effect emerges.
 */

const THREADS = 3
/** Pen rates (rad/s) per thread: x₁, x₂, y₁, y₂, near small-integer ratios so figures nearly close. */
const RATES: readonly (readonly number[])[] = [
  [2.0, 3.02, 3.0, 2.01],
  [3.0, 4.03, 2.0, 5.01],
  [5.0, 3.01, 4.0, 1.99]
]
/** The two pendulums' weights on each axis. */
const WEIGHTS = [0.62, 0.38]
/** Overall rate, and how much a full band energy speeds a thread's pens. */
const SPEED = 0.55
const ENERGY_RATE = 2.2
/** The brightness (pitch) scales every pen: this at the darkest, plus this at the brightest. */
const PITCH_RATE_FLOOR = 0.65
const PITCH_RATE = 0.9
/** How slowly the energies are followed: figures bend, they don't twitch. */
const ENERGY_TAU_SEC = 0.3
/** The figure's radius as a fraction of the shorter side, the level's breath, and an onset's pluck. */
const RADIUS = 0.27
const LEVEL_BREATH = 0.6
const PLUCK = 0.4
const PLUCK_TAU_SEC = 0.3
/** The heat opens the figure up and spins it; a beat thickens the threads and flares the pens. */
const HEAT_SCALE = 0.25
const HEAT_TURN = 5
const PULSE_WIDTH = 1.6
const PULSE_HEAD = 3
/** Radians per second the whole figure turns. */
const TURN_SPEED = 0.06
/** Laying a point every 1/90 s. */
const STEP_SEC = 1 / 90
const BUCKETS = 10
const TAIL_ALPHA = 0.85
const HEAD_ALPHA = 0.8
const COLOURS: readonly PaletteSlotId[] = [
  PaletteSlot.accent,
  PaletteSlot.primary300,
  PaletteSlot.textHighlighted
]
const TAU = Math.PI * 2

/** Tail length in points, by quality: 2, 3 and 4 seconds. */
const TAIL_BY_QUALITY: Readonly<Record<Quality2D, number>> = { low: 180, auto: 270, high: 360 }

export function createSilk<I>(
  ctx: Draw2D<I>,
  quality: Quality2D
): Effect2DInstance<I, AnalysisFrame, Palette> {
  const tail = TAIL_BY_QUALITY[quality]
  /** x, y per point, per thread, in figure units (±1 before the radius). */
  const trails = new Float32Array(THREADS * tail * 2)
  const phases = new Float64Array(THREADS * 4)
  const energies = new Float32Array(THREADS)
  /** This frame's band energies and level, which the steps follow. */
  const targets = new Float32Array(THREADS)
  let targetLevel = 0
  let targetBrightness = 0.5
  let brightness = 0.5
  const drive = createDrive()
  /** The per-step follow factors: constant, because the step is. */
  const energyStep = follow(STEP_SEC, ENERGY_TAU_SEC)
  const pluckStep = follow(STEP_SEC, PLUCK_TAU_SEC)
  for (let thread = 0; thread < THREADS; thread++) {
    // Start the threads apart, so they are not born on top of each other.
    for (let k = 0; k < 4; k++) phases[thread * 4 + k] = (thread * 2.1 + k * 1.3) % TAU
  }

  let width = 0
  let height = 0
  let head = 0
  let carry = 0
  let turn = 0
  let pluck = 0
  let breath = 0

  /** Advance every pen one step and lay a point. */
  function step(): void {
    for (let thread = 0; thread < THREADS; thread++) {
      energies[thread] += (targets[thread] - energies[thread]) * energyStep
    }
    breath += (targetLevel - breath) * energyStep
    brightness += (targetBrightness - brightness) * energyStep
    pluck -= pluck * pluckStep
    const size = 1 + breath * LEVEL_BREATH + pluck * PLUCK
    for (let thread = 0; thread < THREADS; thread++) {
      const rates = RATES[thread]
      const rate =
        SPEED *
        (1 + energies[thread] * ENERGY_RATE) *
        (PITCH_RATE_FLOOR + brightness * PITCH_RATE) *
        STEP_SEC
      const at = thread * 4
      let x = 0
      let y = 0
      for (let k = 0; k < 2; k++) {
        phases[at + k] = (phases[at + k] + rates[k] * rate) % TAU
        phases[at + 2 + k] = (phases[at + 2 + k] + rates[2 + k] * rate) % TAU
        x += WEIGHTS[k] * Math.sin(phases[at + k])
        y += WEIGHTS[k] * Math.sin(phases[at + 2 + k])
      }
      const point = (thread * tail + head) * 2
      trails[point] = x * size
      trails[point + 1] = y * size
    }
    head = (head + 1) % tail
  }

  for (let n = 0; n < tail; n++) step()

  return {
    resize(nextWidth: number, nextHeight: number): void {
      width = nextWidth
      height = nextHeight
    },

    frame(audio, palette, stage: Stage2D<I>, dtSec): void {
      ctx.clearRect(0, 0, width, height)

      // Followed inside the fixed steps, so the threads depend on the step count alone.
      targets[0] = audio.bass
      targets[1] = audio.mid
      targets[2] = audio.treble
      targetLevel = audio.level
      if (!audio.silent) targetBrightness = spectralCentroid(audio.spectrum)
      drive.update(audio, dtSec)
      const pulse = drive.pulse
      const heat = drive.heat
      if (audio.onset > pluck) pluck = audio.onset
      turn = (turn + TURN_SPEED * (1 + heat * HEAT_TURN) * dtSec) % TAU
      carry += dtSec > 0 ? dtSec : 0
      while (carry >= STEP_SEC) {
        carry -= STEP_SEC
        step()
      }
      if (width <= 0 || height <= 0) return

      const intensity = stage.intensity
      const short = width < height ? width : height
      const scale = short * RADIUS * (1 + heat * HEAT_SCALE)
      const cx = width / 2
      const cy = height / 2
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(1, short * 0.0022 * (1 + pulse * PULSE_WIDTH))

      for (let thread = 0; thread < THREADS; thread++) {
        // Each thread sits a third of a turn round from the last.
        const angle = turn + (thread * TAU) / THREADS
        const a = Math.cos(angle) * scale
        const b = Math.sin(angle) * scale
        const base = thread * tail
        ctx.strokeStyle = palette.css[COLOURS[thread]]
        for (let bucket = 0; bucket < BUCKETS; bucket++) {
          const from = Math.floor((bucket * (tail - 1)) / BUCKETS)
          const to = Math.floor(((bucket + 1) * (tail - 1)) / BUCKETS)
          const strength = (bucket + 1) / BUCKETS
          ctx.globalAlpha = strength * strength * TAIL_ALPHA * intensity
          ctx.beginPath()
          for (let i = from; i <= to; i++) {
            // Logical 0 is the oldest point, tail − 1 the newest.
            const point = (base + ((head + i) % tail)) * 2
            const x = trails[point]
            const y = trails[point + 1]
            const px = cx + x * a - y * b
            const py = cy + x * b + y * a
            if (i === from) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          }
          ctx.stroke()
        }
        // The pen.
        const pen = (base + ((head + tail - 1) % tail)) * 2
        const x = trails[pen]
        const y = trails[pen + 1]
        ctx.globalAlpha = HEAD_ALPHA * intensity
        ctx.fillStyle = palette.css[PaletteSlot.textHighlighted]
        ctx.beginPath()
        ctx.arc(
          cx + x * a - y * b,
          cy + x * b + y * a,
          Math.max(1, short * 0.004 * (1 + pulse * PULSE_HEAD)),
          0,
          TAU
        )
        ctx.fill()
      }

      ctx.globalAlpha = 1
    },

    dispose(): void {
      ctx.clearRect(0, 0, width, height)
    }
  }
}
