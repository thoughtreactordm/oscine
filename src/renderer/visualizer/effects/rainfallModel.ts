import type { AnalysisFrame } from '../analysisFrame'
import { follow } from './draw2d'

/**
 * Rainfall's per-frame parameters — **W23-11, D35.9, D35.11, D35.12**. The
 * shaders are in `rainfall.ts`; everything that decides *how much* and *when*
 * lives here, pure and DOM-free, so the card's properties are testable
 * without a GPU.
 *
 * **The surface** is a height field on a ping-pong pair, stepped by the damped
 * wave equation
 *
 * ```
 * h' = (2h − h₋ + c²·∇²h) · damp + drop
 * ```
 *
 * on a fixed grid of {@link SIM_ROWS} rows (columns follow the aspect) at a
 * fixed {@link STEP_SEC}. Both are fixed on purpose. A stable explicit wave
 * equation moves under one cell per step, so a grid at the internal resolution
 * (1080 rows at 4K Zen) would need dozens of steps a frame for a ripple to
 * cross the stage in a couple of seconds. A grid tied to the internal size
 * would also change the ripples' speed with the quality setting. On a fixed
 * grid at a fixed step, the speed, the ring size and the damping are the same
 * in stage units on every machine and at every frame rate. The accumulator
 * ({@link RainfallModel.advance}) decides how many steps a frame runs.
 *
 * **Damping is `dtSec`-correct**: the per-step factor is derived from
 * {@link RIPPLE_TAU_SEC} and the step length, so a ring has lost the same
 * share after two seconds at 30 fps as at 144. The leapfrog recurrence decays
 * each mode by √damp per step, so `damp = exp(−2·step/τ)`.
 *
 * **Drops** follow the flash guard's onset envelope (D35.8). The envelope
 * ramps up over at least `MIN_ATTACK_SEC`. Each frame's *rise* is injected as
 * a Gaussian at the drop's position, so a ring's energy arrives no faster than
 * the guard lets an onset rise. A new drop starts each time the envelope
 * starts rising again. Its position comes from the band that rose most in that
 * frame: low bands near the bottom, highs near the top, with jitter. Its size
 * grows with the envelope, so a strong onset makes a wider ring.
 *
 * **Emergence** (D35.12) scales the injection, the refraction, the highlight
 * and the cover layer, all from exactly zero. At 0 the shader skips every
 * branch and outputs the wash texel for texel, whatever ripples the field
 * still holds.
 */

/** Grid rows; the columns are `rows × aspect`, capped. */
export const SIM_ROWS = 256
export const SIM_MAX_COLS = 1024
/** The fixed step, and the most a frame will run (dtSec is clamped to 0.1 s). */
export const STEP_SEC = 1 / 150
export const MAX_STEPS = 15
/** (c·Δt/Δx)², under the 2-D stability limit of 0.5. About 0.37 stage heights a second at 256 rows. */
export const WAVE_C2 = 0.4
/** A ripple's amplitude e-folds over this: under 4 % is left after 2 s. */
export const RIPPLE_TAU_SEC = 0.6

/** The cover layer's opacity at full emergence. */
export const RAINFALL_OPACITY = 0.85
/** Extra mips of blur at emergence 0, falling to 0 at full emergence. */
export const LOD_GROW = 2

/** A full-strength onset's total injected height, before emergence. */
export const DROP_AMPLITUDE = 9
/** The drop's Gaussian radius, units of stage height, from a weak onset to a full one. */
export const DROP_SIGMA_MIN = 0.012
export const DROP_SIGMA_MAX = 0.034
/** Where the bands land vertically, as v (y-up): the lowest band to the highest. */
export const DROP_V_LOW = 0.14
export const DROP_V_HIGH = 0.86
/** Jitter: ± this much of v, and how far across the width a drop may land (centred). */
export const DROP_V_JITTER = 0.07
export const DROP_U_SPAN = 0.8
/** A rise smaller than this is noise in the envelope, not a drop. */
const RISE_EPSILON = 1e-4

/** UV offset, units of stage height, per unit of height difference across one cell. */
export const REFRACT = 0.3
/** The crest highlight's gain on slope, and its ceiling. */
export const HIGHLIGHT_GAIN = 2.2
export const HIGHLIGHT_MAX = 0.16
/** Slow level follower that lifts the highlight on louder passages. */
const LEVEL_TAU_SEC = 0.8

export interface RainfallDrop {
  /** Stage UV of the current drop's centre, y-up. */
  u: number
  v: number
  /** Height to add this frame's first step; 0 when nothing is rising. */
  amplitude: number
  /** Gaussian radius, units of stage height. */
  sigma: number
}

export interface RainfallParams {
  /** 0..1: how far the cover layer has replaced the wash. 0 = the wash exactly. */
  detail: number
  /** The cover layer's opacity: the wash's at emergence 0, {@link RAINFALL_OPACITY} at 1. */
  opacity: number
  /** Extra mips over the floor. */
  lodBias: number
  /** Refraction, units of height per unit slope; 0 skips the moved sample. */
  refract: number
  /** Crest highlight gain on slope; 0 adds nothing. */
  highlight: number
  /** The highlight's ceiling, scaled by emergence like everything else. */
  highlightMax: number
  /** How much of the result to present over the wash (the flash guard, D35.8). */
  present: number
}

export interface RainfallModel {
  readonly params: Readonly<RainfallParams>
  readonly drop: Readonly<RainfallDrop>
  /** The per-step damping factor. */
  readonly damp: number
  /**
   * Advance the step accumulator by `dtSec`. Returns how many fixed steps to
   * run this frame (0..{@link MAX_STEPS}). Call it once a frame, before
   * {@link update}.
   */
  advance(dtSec: number): number
  update(
    audio: AnalysisFrame,
    emergence: number,
    intensity: number,
    washOpacity: number,
    dtSec: number
  ): Readonly<RainfallParams>
  /**
   * The drop's height has been injected (the frame ran at least one step).
   * Until then, rises carry over, so a frame that runs no step loses nothing.
   */
  consumeDrop(): void
  /** Forget the surface: the field was reallocated or cleared. */
  reset(): void
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** mulberry32: small, seedable, good enough for jitter. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The per-step damping that leaves `exp(−t/τ)` of a ripple's amplitude after t seconds. */
export function stepDamping(stepSec: number = STEP_SEC, tauSec: number = RIPPLE_TAU_SEC): number {
  return Math.exp((-2 * stepSec) / tauSec)
}

/** The grid for a stage of this aspect (width / height). */
export function simSize(aspect: number): { cols: number; rows: number } {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1
  return { cols: Math.max(1, Math.min(SIM_MAX_COLS, Math.round(SIM_ROWS * a))), rows: SIM_ROWS }
}

/**
 * The band that best places this onset: the one whose energy rose most since
 * the last frame, or, if none rose, the loudest. -1 for an empty spectrum.
 */
export function dominantBand(spectrum: ArrayLike<number>, previous: ArrayLike<number>): number {
  let best = -1
  let bestRise = 0
  for (let band = 0; band < spectrum.length; band++) {
    const rise = spectrum[band] - previous[band]
    if (rise > bestRise) {
      bestRise = rise
      best = band
    }
  }
  if (best >= 0) return best
  let loudest = 0
  for (let band = 0; band < spectrum.length; band++) {
    if (spectrum[band] > loudest) {
      loudest = spectrum[band]
      best = band
    }
  }
  return best
}

/** The v (y-up) a band lands at, before jitter. */
export function bandHeight(band: number, bands: number): number {
  const t = bands > 1 && band >= 0 ? band / (bands - 1) : 0.5
  return DROP_V_LOW + (DROP_V_HIGH - DROP_V_LOW) * clamp01(t)
}

export function createRainfallModel(seed = 0x0eca1): RainfallModel {
  const params: RainfallParams = {
    detail: 0,
    opacity: 0,
    lodBias: LOD_GROW,
    refract: 0,
    highlight: 0,
    highlightMax: 0,
    present: 1
  }
  const drop: RainfallDrop = { u: 0.5, v: 0.5, amplitude: 0, sigma: DROP_SIGMA_MIN }
  const damp = stepDamping()
  const random = createRandom(seed)
  let previousSpectrum: Float32Array | null = null
  let accumulator = 0
  let lastOnset = 0
  let rising = false
  let pending = 0
  let level = 0

  return {
    params,
    drop,
    damp,

    advance(dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      accumulator += dt
      let steps = Math.floor(accumulator / STEP_SEC + 1e-9)
      accumulator -= steps * STEP_SEC
      if (accumulator < 0) accumulator = 0
      if (steps > MAX_STEPS) {
        // A stall: run what is allowed and drop the rest rather than catching up.
        steps = MAX_STEPS
        accumulator = 0
      }
      return steps
    },

    update(audio, emergence, intensity, washOpacity, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      const e = clamp01(emergence)
      const guard = clamp01(intensity)
      const spectrum = audio.spectrum
      if (!previousSpectrum || previousSpectrum.length !== spectrum.length) {
        previousSpectrum = new Float32Array(spectrum)
      }
      level += (audio.level - level) * follow(dt, LEVEL_TAU_SEC)

      // The onset envelope: each rise is a share of the current drop.
      const onset = clamp01(audio.onset)
      const rise = onset - lastOnset
      if (rise > RISE_EPSILON) {
        if (!rising) {
          // A new drop: placed by the band that rose, jittered.
          const band = dominantBand(spectrum, previousSpectrum)
          const v = bandHeight(band, spectrum.length) + (random() * 2 - 1) * DROP_V_JITTER
          drop.v = Math.min(0.97, Math.max(0.03, v))
          drop.u = 0.5 + (random() - 0.5) * DROP_U_SPAN
          pending = 0
          rising = true
        }
        pending += rise * DROP_AMPLITUDE * e
        drop.sigma = DROP_SIGMA_MIN + (DROP_SIGMA_MAX - DROP_SIGMA_MIN) * onset
      } else {
        rising = false
      }
      lastOnset = onset
      drop.amplitude = pending
      previousSpectrum.set(spectrum)

      params.detail = e
      params.opacity = clamp01(washOpacity) + (RAINFALL_OPACITY - clamp01(washOpacity)) * e
      params.lodBias = LOD_GROW * (1 - e)
      params.refract = REFRACT * e
      params.highlight = HIGHLIGHT_GAIN * (0.6 + 0.4 * clamp01(level)) * e
      params.highlightMax = HIGHLIGHT_MAX * e
      params.present = guard
      return params
    },

    consumeDrop() {
      pending = 0
      drop.amplitude = 0
    },

    reset() {
      pending = 0
      drop.amplitude = 0
      accumulator = 0
    }
  }
}
