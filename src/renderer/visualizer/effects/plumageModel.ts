import type { AnalysisFrame } from '../analysisFrame'
import { MAX_RISE_PER_FRAME, MIN_ATTACK_SEC, ONSET_RELEASE_SEC } from '../flashGuard'
import { multiplierParam, resolveParams, type EffectParamSpec, type EffectParams } from '../params'
import type { Drive } from './drive'
import { follow } from './draw2d'

/**
 * Plumage's per-frame parameters — **W23-10, D35.9, D35.11, D35.12**. The
 * shader is in `plumage.ts`; everything that decides *how much* lives here,
 * pure and DOM-free, so the card's properties can be tested without a GPU.
 *
 * One pass a frame. For each pixel `p` (centred, aspect-corrected):
 *
 * ```
 * q      = mix(p, fold(p), kaleido)           the kaleidoscope, eased in by emergence
 * q     += displace(q)                        low bands move large regions, highs shimmer
 * wash'  = wash(q)                            the wash, moved
 * cover' = cover(q) at a mip ≥ the blur floor the cover's own detail, saturated as the wash is
 * out    = mix(wash', cover', detail)         the cover sharpens out of the wash
 * out    = mix(wash(p), out, present)         the flash guard falls back to the wash
 * ```
 *
 * with the chromatic split, when non-zero, sampling red and blue at `q ± split`
 * along the radius.
 *
 * **Emergence** (D35.12) scales every term from exactly nothing: at 0 the fold
 * and displacement add exactly zero, `detail` is 0 and the split is 0, so the
 * output is the wash texel for texel. The shader skips the cover and the
 * split entirely there, so no rounding can creep in.
 *
 * **Never sharp at full size.** The cover is a 640-px source under a stage that
 * can be 4K; the cover layer is sampled no finer than {@link BLUR_FRACTION} of
 * the stage height per texel ({@link detailLodFloor}), and starts
 * {@link LOD_GROW} mips blurrier than that at low emergence, so it sharpens
 * out of the wash rather than appearing over it.
 */

/** The cover layer's opacity at full emergence (the wash's own is ~0.2). */
export const PLUMAGE_OPACITY = 0.82
/** The finest the cover layer is sampled: one texel per this fraction of the visible cover's height. */
export const BLUR_FRACTION = 1 / 48
/** Extra mips of blur at emergence 0, falling to 0 at full emergence. */
export const LOD_GROW = 2

/** Displacement, units of stage height, at a band energy of 1. */
const DISPLACE_LOW = 0.05
const DISPLACE_LOW_PULSE = 0.03
const DISPLACE_MID = 0.018
const DISPLACE_HIGH = 0.006
/** A floor so the field still breathes in a quiet passage. */
const DISPLACE_IDLE = 0.008
/** Band followers: the bands are already enveloped by the guard; these only steady them. */
const BAND_TAU_SEC = 0.12
const SHIMMER_TAU_SEC = 0.06
/** Noise phases, in noise cells per second, and how much heat speeds them up. */
const LOW_SPEED = 0.06
const HIGH_SPEED = 0.45
const SPEED_HEAT = 1.5

/** Kaleidoscope segment counts (each mirrored, so 2N wedges show), from level. */
export const SEGMENTS_MIN = 3
export const SEGMENTS_MAX = 8
/** Level is followed this slowly before it picks a count, so a count holds for phrases, not beats. */
const LEVEL_TAU_SEC = 2.5
/** The continuous count must move this far past the held one before it changes. */
const SEGMENT_HYSTERESIS = 0.65
/** A count change eases over this. */
export const SEGMENT_EASE_SEC = 1.4
/** How much of the fold applies at full emergence: some at rest, all of it when loud. */
const KALEIDO_BASE = 0.55
const KALEIDO_LEVEL = 0.45
/** Rotation, radians per second; it reverses smoothly once every half period. */
const ROTATION_BASE = 0.05
const ROTATION_LEVEL = 0.22
const ROTATION_PERIOD_SEC = 120

/** The chromatic split at a full onset, units of stage height. */
export const SPLIT_MAX = 0.007

export interface PlumageParams {
  /** 0..1: how far the cover layer has replaced the wash. 0 = the wash exactly. */
  detail: number
  /** The cover layer's opacity: the wash's at emergence 0, {@link PLUMAGE_OPACITY} at 1. */
  opacity: number
  /** Extra mips over the floor. */
  lodBias: number
  /** Displacement amplitudes, units of height. */
  displaceLow: number
  displaceMid: number
  displaceHigh: number
  /** Noise phases, wrapped small so float32 keeps its fraction. */
  lowPhase: number
  highPhase: number
  /** The fold's share of the coordinate, 0..1. */
  kaleido: number
  /** The two counts being eased between, and the blend from A to B. */
  segmentsA: number
  segmentsB: number
  segmentBlend: number
  /** The fold's rotation, radians in [0, 2π). */
  rotation: number
  /** The chromatic split, units of height; 0 skips the extra samples. */
  split: number
  /** How much of the result to present over the wash (the flash guard, D35.8). */
  present: number
}

export interface PlumageModel {
  readonly params: Readonly<PlumageParams>
  /** The split's envelope, 0..1, before emergence and intensity: for the tests. */
  readonly splitEnvelope: number
  update(
    audio: AnalysisFrame,
    drive: Pick<Drive, 'pulse' | 'heat'>,
    emergence: number,
    intensity: number,
    washOpacity: number,
    dtSec: number
  ): Readonly<PlumageParams>
}

const TAU = Math.PI * 2

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** The count `level` asks for, continuous. */
function segmentsFor(level: number): number {
  return SEGMENTS_MIN + (SEGMENTS_MAX - SEGMENTS_MIN) * clamp01(level)
}

/** Scales the ripple, flow speed, kaleidoscope, spin and colour split. */
export const PLUMAGE_KNOBS: readonly EffectParamSpec[] = [
  multiplierParam('ripple', 'Ripple', 'How far the picture ripples.', { min: 0, max: 3 }),
  multiplierParam('speed', 'Flow speed', 'How fast the ripples move.', { min: 0, max: 3 }),
  multiplierParam('fold', 'Kaleidoscope', 'How much the picture folds.', { min: 0, max: 1.5 }),
  multiplierParam('spin', 'Spin', 'How fast the kaleidoscope turns.', { min: 0, max: 3 }),
  multiplierParam('split', 'Colour split', 'How far the colours split.', { min: 0, max: 3 })
]

export function createPlumageModel(
  knobs: EffectParams = resolveParams(PLUMAGE_KNOBS, undefined)
): PlumageModel {
  const params: PlumageParams = {
    detail: 0,
    opacity: 0,
    lodBias: LOD_GROW,
    displaceLow: 0,
    displaceMid: 0,
    displaceHigh: 0,
    lowPhase: 0,
    highPhase: 0,
    kaleido: 0,
    segmentsA: SEGMENTS_MIN,
    segmentsB: SEGMENTS_MIN,
    segmentBlend: 1,
    rotation: 0,
    split: 0,
    present: 1
  }
  let low = 0
  let mid = 0
  let high = 0
  let level = 0
  let levelPrimed = false
  let time = 0
  let envelope = 0

  return {
    params,
    get splitEnvelope() {
      return envelope
    },

    update(audio, drive, emergence, intensity, washOpacity, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      const e = clamp01(emergence)
      const guard = clamp01(intensity)
      time += dt

      low += (audio.bass - low) * follow(dt, BAND_TAU_SEC)
      mid += (audio.mid - mid) * follow(dt, BAND_TAU_SEC)
      high += (audio.treble - high) * follow(dt, SHIMMER_TAU_SEC)
      if (levelPrimed) level += (audio.level - level) * follow(dt, LEVEL_TAU_SEC)
      else {
        level = audio.level
        levelPrimed = true
      }

      params.detail = e
      params.opacity = clamp01(washOpacity) + (PLUMAGE_OPACITY - clamp01(washOpacity)) * e
      params.lodBias = LOD_GROW * (1 - e)

      params.displaceLow =
        e *
        (DISPLACE_IDLE * knobs.ripple +
          DISPLACE_LOW * knobs.ripple * low +
          DISPLACE_LOW_PULSE * knobs.ripple * drive.pulse)
      params.displaceMid = e * DISPLACE_MID * knobs.ripple * mid
      params.displaceHigh = e * DISPLACE_HIGH * knobs.ripple * high
      const speed = 1 + SPEED_HEAT * drive.heat
      params.lowPhase = (params.lowPhase + dt * LOW_SPEED * knobs.speed * speed) % 256
      params.highPhase =
        (params.highPhase + dt * HIGH_SPEED * knobs.speed * speed * (1 + high)) % 256

      // The count: held until the slow level moves well past it, then eased.
      if (params.segmentBlend < 1) {
        params.segmentBlend = Math.min(1, params.segmentBlend + dt / SEGMENT_EASE_SEC)
      }
      if (params.segmentBlend >= 1) {
        params.segmentsA = params.segmentsB
        const wanted = segmentsFor(level)
        if (Math.abs(wanted - params.segmentsB) > SEGMENT_HYSTERESIS) {
          params.segmentsB = Math.round(wanted)
          if (params.segmentsB !== params.segmentsA) params.segmentBlend = 0
        }
      }
      // A mix share, so the fold stays within 0..1.
      params.kaleido = e * clamp01(KALEIDO_BASE * knobs.fold + KALEIDO_LEVEL * knobs.fold * level)

      const direction = Math.cos((time * TAU) / ROTATION_PERIOD_SEC)
      params.rotation +=
        dt * (ROTATION_BASE * knobs.spin + ROTATION_LEVEL * knobs.spin * level) * direction
      params.rotation = ((params.rotation % TAU) + TAU) % TAU

      // The split's envelope. The guard has already shaped the onset (D35.8);
      // this holds the split to the same attack whatever it is fed.
      const target = clamp01(audio.onset)
      if (target > envelope) {
        const rise = Math.min(dt / MIN_ATTACK_SEC, MAX_RISE_PER_FRAME)
        envelope = Math.min(target, envelope + rise)
      } else {
        envelope += (target - envelope) * follow(dt, ONSET_RELEASE_SEC)
      }
      params.split = SPLIT_MAX * knobs.split * envelope * e * guard

      params.present = guard
      return params
    }
  }
}

/**
 * The finest mip the cover layer may sample: the level at which one texel
 * covers {@link BLUR_FRACTION} of the visible cover's height. `coverHeight` is
 * the bitmap's, `visibleV` the fraction of it on the stage (the v span of
 * `coverUvTransform`, so the wash's `scale()` and the object-cover crop count).
 */
export function detailLodFloor(coverHeight: number, visibleV: number): number {
  const texels = coverHeight * Math.abs(visibleV) * BLUR_FRACTION
  return texels > 1 ? Math.log2(texels) : 0
}

/**
 * The kaleidoscope's fold of an angle, as the shader computes it: a triangle
 * wave of period 2π/N, so the wedge and its mirror alternate. For integer N it
 * is continuous everywhere, the ±π wrap included — which is why the counts are
 * integers and eased by blending folds, never fractional.
 */
export function foldAngle(angle: number, segments: number, rotation: number): number {
  const period = TAU / segments
  const a = angle + rotation
  const t = a - period * Math.floor(a / period)
  return Math.min(t, period - t)
}
