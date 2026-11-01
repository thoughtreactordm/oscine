import type { AnalysisFrame } from '../analysisFrame'
import { follow } from './draw2d'

/**
 * Groove's per-frame parameters — **W23-11, D35.9, D35.11, D35.12**. The
 * shader is in `groove.ts`; this decides how much, pure and DOM-free.
 *
 * Groove is a radial slit-scan: the cover smeared tangentially around the
 * stage centre, like a record turning under a light. For a pixel at polar
 * `(r, θ)` the shader averages the image along the arc behind it,
 * `θ … θ + L(θ)`, weighted towards `θ`. The record turns clockwise, so what is
 * at θ now came from the larger angle.
 *
 * - **Smear length** `L` comes from `level`. It is longest under a two-lobed
 *   light band and {@link SMEAR_FLOOR} of that elsewhere.
 * - **Angular velocity** comes from `bass`. The light band turns at it, so the
 *   long streaks sweep around the cover the way a record's sheen does. The
 *   cover itself never rotates: a rotated cover could not equal the wash at
 *   emergence 0 without unwinding, and an unwind would read as a spin-back.
 * - **Sheen**: the band also lifts the palette's highlight a little, a soft
 *   arc of light across the "grooves", scaled by level.
 *
 * **Emergence** (D35.12) scales the smear, the sheen and the cover layer from
 * exactly zero. At 0 the shader skips the arc and returns the wash texel for
 * texel. The phase keeps turning at every emergence, so the band never jumps
 * when the effect comes back.
 */

/** Smear, radians of arc at the light band, at rest and per unit of level. */
export const SMEAR_IDLE = 0.08
export const SMEAR_LEVEL = 0.72
/** The smear outside the band, as a share of the smear under it. */
export const SMEAR_FLOOR = 0.3
/** Angular velocity, radians per second, at rest and per unit of bass. */
export const OMEGA_BASE = 0.35
export const OMEGA_BASS = 2.4
/** The sheen's ceiling, and how much of it is there at rest. */
export const SHEEN_MAX = 0.14
const SHEEN_REST = 0.45
/** The cover layer's opacity at full emergence. */
export const GROOVE_OPACITY = 0.82
/** Extra mips of blur at emergence 0, falling to 0 at full emergence. */
export const LOD_GROW = 2

/** The level is steadied a little, so the smear breathes rather than jitters. */
const LEVEL_TAU_SEC = 0.15
/** The bass sets the speed slowly, as a platter would: no lurch on a kick. */
const BASS_TAU_SEC = 0.4

const TAU = Math.PI * 2

export interface GrooveParams {
  /** 0..1: how far the cover layer has replaced the wash. 0 = the wash exactly. */
  detail: number
  /** The cover layer's opacity: the wash's at emergence 0, {@link GROOVE_OPACITY} at 1. */
  opacity: number
  /** Extra mips over the floor. */
  lodBias: number
  /** Arc length under the light band, radians; 0 skips the arc. */
  smear: number
  /** The light band's angle, radians in [0, 2π); it decreases (clockwise). */
  phase: number
  /** Angular velocity this frame, radians per second (positive = clockwise). */
  omega: number
  /** Highlight added under the band; 0 adds nothing. */
  sheen: number
  /** How much of the result to present over the wash (the flash guard, D35.8). */
  present: number
}

export interface GrooveModel {
  readonly params: Readonly<GrooveParams>
  update(
    audio: AnalysisFrame,
    emergence: number,
    intensity: number,
    washOpacity: number,
    dtSec: number
  ): Readonly<GrooveParams>
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

export function createGrooveModel(): GrooveModel {
  const params: GrooveParams = {
    detail: 0,
    opacity: 0,
    lodBias: LOD_GROW,
    smear: 0,
    phase: 0,
    omega: OMEGA_BASE,
    sheen: 0,
    present: 1
  }
  let level = 0
  let bass = 0
  let primed = false

  return {
    params,

    update(audio, emergence, intensity, washOpacity, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      const e = clamp01(emergence)
      if (primed) {
        level += (audio.level - level) * follow(dt, LEVEL_TAU_SEC)
        bass += (audio.bass - bass) * follow(dt, BASS_TAU_SEC)
      } else {
        level = audio.level
        bass = audio.bass
        primed = true
      }
      const l = clamp01(level)

      params.detail = e
      params.opacity = clamp01(washOpacity) + (GROOVE_OPACITY - clamp01(washOpacity)) * e
      params.lodBias = LOD_GROW * (1 - e)
      params.smear = e * (SMEAR_IDLE + SMEAR_LEVEL * l)
      params.omega = OMEGA_BASE + OMEGA_BASS * clamp01(bass)
      params.phase = (((params.phase - dt * params.omega) % TAU) + TAU) % TAU
      params.sheen = e * SHEEN_MAX * (SHEEN_REST + (1 - SHEEN_REST) * l)
      params.present = clamp01(intensity)
      return params
    }
  }
}

/**
 * The light band at an angle: two soft lobes, 1 on the band and 0 across
 * from it, as the shader computes it.
 */
export function lightBand(angle: number, phase: number): number {
  const c = 0.5 + 0.5 * Math.cos(2 * (angle - phase))
  return c * c
}

/** The arc length the shader smears at an angle: {@link SMEAR_FLOOR} of `smear` off the band. */
export function smearAt(angle: number, smear: number, phase: number): number {
  return smear * (SMEAR_FLOOR + (1 - SMEAR_FLOOR) * lightBand(angle, phase))
}
