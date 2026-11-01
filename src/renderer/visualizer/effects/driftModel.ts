import { gammaEncode } from '@shared/theme'
import type { AnalysisFrame } from '../analysisFrame'
import { PaletteSlot, type Palette } from '../palette'
import { multiplierParam, resolveParams, type EffectParamSpec, type EffectParams } from '../params'
import type { Drive } from './drive'
import { follow } from './draw2d'

/**
 * Drift's per-frame parameters — **W23-9, D35.9, D35.12**. The shader is in
 * `drift.ts`; everything that decides *how much* lives here, pure and
 * DOM-free, so the properties the card asks for can be tested without a GPU.
 *
 * Each frame the feedback field `F` is rebuilt from the last one:
 *
 * ```
 * warped = F(warp(uv))                      zoom (bass), spin (mid), turbulence (treble)
 * warped = mix(warped, dark, decay)         decay towards the darker ramp steps
 * warped = mix(warped, line, lineMask)      the waveform ring, coloured from cover + palette
 * F'     = mix(wash, warped, keep)          re-seeded from the wash
 * ```
 *
 * Every step is a convex mix of colours that are themselves in range, so the
 * field is bounded by its inputs: it cannot run away to white (no step adds),
 * and it cannot die out to black, because the wash, the ring and the decay
 * target — a palette colour, not black — keep feeding it.
 *
 * **Emergence** (D35.12) is folded into every rate rather than multiplied into
 * one frame's mix, so growth is frame-rate independent too:
 *
 * - `keep` is `exp(−dt·rate)` with a rate that is infinite at emergence 0, so
 *   there `F'` is the wash exactly — Drift at 0 *is* the wash — and falls to
 *   {@link RESEED_RATE} at 1, where the wash still trickles in. That trickle
 *   is how a track change reaches the field: the wash runs the cover crossfade
 *   (D35.11), and the new cover melts in rather than the buffer resetting.
 * - the warp, decay and ring all scale with emergence, so the stage's cover
 *   visibly starts to move rather than a tunnel being cut in.
 *
 * Colours are kept as the field stores them: premultiplied, sRGB-encoded,
 * like the wash texture and a 2D canvas (`gl/target.ts`).
 */

/** At full emergence the wash re-seeds this fraction of the field per second (as a rate). */
export const RESEED_RATE = 0.35
/** How fast `keep` climbs as emergence grows; the field is the wash at 0. */
const GROW_RATE = 4
/** Decay towards the darker ramp steps, per second at full emergence. */
export const DECAY_RATE = 0.45

/** Zoom, as a log rate per second: content rushes outward at this speed. */
const ZOOM_BASE = 0.12
const ZOOM_BASS = 0.75
const ZOOM_PULSE = 0.9
const ZOOM_HEAT = 0.35

/** Spin in radians per second, and how far the spin direction swings over a cycle. */
const SPIN_BASE = 0.12
const SPIN_MID = 0.9
/** The spin reverses smoothly once every half of this period. */
const SPIN_PERIOD_SEC = 96
/** Extra spin per unit of radius: the field twists rather than turning rigidly. */
const TWIST_MID = 1.4

/** Turbulence: displacement in field units per second, and the noise's own speed. */
const TURBULENCE_BASE = 0.004
const TURBULENCE_TREBLE = 0.05
const TURBULENCE_SPEED = 0.35

/** The waveform ring, in units of the stage's height. */
const RING_RADIUS = 0.15
const RING_RADIUS_HEAT = 0.07
const RING_RADIUS_PULSE = 0.05
const RING_AMPLITUDE = 0.05
const RING_AMPLITUDE_HEAT = 0.05
/** The ring's opacity into the field: a mix, never an add. */
const RING_ALPHA = 0.5
const RING_ALPHA_PULSE = 0.4
/** The ring fades over this when the music stops, so silence doesn't stamp a still circle. */
const RING_FADE_SEC = 0.5
/** The ring's width, as a fraction of the height, and never under this many pixels. */
export const RING_WIDTH = 0.004
export const RING_WIDTH_MIN_PX = 1.5
/** How much of the ring's colour comes from the cover under it (the rest is the palette). */
export const RING_COVER_SHARE = 0.55

export interface DriftParams {
  /** How much of the warped field survives into this frame; 0 = the wash exactly. */
  keep: number
  /** Mix towards the dark target this frame. */
  decay: number
  /** Zoom factor this frame (≥ 1); the shader samples `p / zoom`. */
  zoom: number
  /** Rigid rotation this frame, radians. */
  spin: number
  /** Extra rotation this frame per unit of radius. */
  twist: number
  /** Turbulent displacement this frame, field units. */
  turbulence: number
  /** The turbulence noise's phase. */
  turbulencePhase: number
  /** Ring radius and waveform amplitude, units of height. */
  ringRadius: number
  ringAmplitude: number
  /** The ring's mix into the field. */
  ringAlpha: number
  /** How much of the result to present over the wash (the flash guard, D35.8). */
  present: number
  /** Dither amplitude in 8-bit steps: 0 at emergence 0, so the wash is exact there. */
  dither: number
}

/** Premultiplied sRGB-encoded colours, three per entry, for the shader. */
export interface DriftColours {
  /** Two decay targets: the darker ramp steps, alpha 1. */
  readonly darkA: Float32Array
  readonly darkB: Float32Array
  /** The ring's palette colour at rest, and on a beat. */
  readonly ring: Float32Array
  readonly ringBeat: Float32Array
}

export interface DriftModel {
  readonly params: Readonly<DriftParams>
  readonly colours: DriftColours
  /** Forget the field's history: the next frame re-seeds from the wash. */
  reseed(): void
  update(
    audio: AnalysisFrame,
    drive: Pick<Drive, 'pulse' | 'heat'>,
    emergence: number,
    intensity: number,
    dtSec: number
  ): Readonly<DriftParams>
  /** Re-read the palette's colours; cheap to call every frame (keyed on `version`). */
  updateColours(palette: Palette): DriftColours
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function encodeSlot(palette: Palette, slot: number, out: Float32Array): void {
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = gammaEncode(palette.linear[slot * 3 + channel])
  }
}

/** Scales zoom, spin, turbulence, field persistence and the waveform ring. */
export const DRIFT_KNOBS: readonly EffectParamSpec[] = [
  multiplierParam('zoom', 'Zoom', 'How fast the field rushes outward.', { min: 0, max: 3 }),
  multiplierParam('spin', 'Spin', 'How fast the field turns and twists.', { min: 0, max: 3 }),
  multiplierParam('turbulence', 'Turbulence', 'How much the field churns.', { min: 0, max: 3 }),
  multiplierParam('persistence', 'Persistence', 'How long colours linger.', { min: 0.5, max: 2 }),
  multiplierParam('ring', 'Waveform ring', 'How strongly the ring shows.', { min: 0, max: 2 })
]

export function createDriftModel(
  knobs: EffectParams = resolveParams(DRIFT_KNOBS, undefined)
): DriftModel {
  const params: DriftParams = {
    keep: 0,
    decay: 0,
    zoom: 1,
    spin: 0,
    twist: 0,
    turbulence: 0,
    turbulencePhase: 0,
    ringRadius: RING_RADIUS,
    ringAmplitude: RING_AMPLITUDE,
    ringAlpha: 0,
    present: 1,
    dither: 0
  }
  const colours: DriftColours = {
    darkA: new Float32Array(3),
    darkB: new Float32Array(3),
    ring: new Float32Array(3),
    ringBeat: new Float32Array(3)
  }
  let colourVersion = -1
  let reseedPending = true
  let time = 0
  let ringGain = 0

  return {
    params,
    colours,
    reseed() {
      reseedPending = true
    },

    update(audio, drive, emergence, intensity, dtSec) {
      const dt = dtSec > 0 ? dtSec : 0
      const e = clamp01(emergence)
      const guard = clamp01(intensity)
      time += dt

      if (reseedPending || e <= 0) {
        params.keep = 0
      } else {
        params.keep = Math.exp(-dt * (RESEED_RATE + (GROW_RATE * (1 - e)) / e))
      }
      reseedPending = false

      // Divided so a higher knob slows the fade and the field lingers.
      params.decay = 1 - Math.exp(-dt * (DECAY_RATE / knobs.persistence) * e)

      const zoomRate =
        ZOOM_BASE * knobs.zoom +
        ZOOM_BASS * knobs.zoom * audio.bass +
        ZOOM_PULSE * knobs.zoom * drive.pulse +
        ZOOM_HEAT * knobs.zoom * drive.heat
      params.zoom = Math.exp(dt * e * zoomRate)

      const direction = Math.cos((time * 2 * Math.PI) / SPIN_PERIOD_SEC)
      params.spin =
        dt * e * (SPIN_BASE * knobs.spin + SPIN_MID * knobs.spin * audio.mid) * direction
      params.twist = dt * e * TWIST_MID * knobs.spin * audio.mid * direction

      params.turbulence =
        dt *
        e *
        (TURBULENCE_BASE * knobs.turbulence + TURBULENCE_TREBLE * knobs.turbulence * audio.treble)
      params.turbulencePhase += dt * TURBULENCE_SPEED * (1 + 2 * audio.treble)
      // Keep the phase small so float32 in the shader never loses its fraction.
      if (params.turbulencePhase > 1000) params.turbulencePhase -= 1000

      ringGain += ((audio.silent ? 0 : 1) - ringGain) * follow(dt, RING_FADE_SEC)
      params.ringRadius =
        RING_RADIUS + RING_RADIUS_HEAT * drive.heat + RING_RADIUS_PULSE * drive.pulse
      params.ringAmplitude = RING_AMPLITUDE + RING_AMPLITUDE_HEAT * drive.heat
      params.ringAlpha = clamp01(
        e *
          guard *
          ringGain *
          (RING_ALPHA * knobs.ring + RING_ALPHA_PULSE * knobs.ring * drive.pulse)
      )

      params.present = guard
      params.dither = e > 0 ? 1 : 0
      return params
    },

    updateColours(palette) {
      if (palette.version === colourVersion) return colours
      colourVersion = palette.version
      encodeSlot(palette, PaletteSlot.primary900, colours.darkA)
      encodeSlot(palette, PaletteSlot.primary950, colours.darkB)
      encodeSlot(palette, PaletteSlot.accent, colours.ring)
      encodeSlot(palette, PaletteSlot.textHighlighted, colours.ringBeat)
      return colours
    }
  }
}

/**
 * The field's recurrence for one channel of one pixel, as the shader runs it
 * (less the warp, which only moves values around). For the tests: it is what
 * lets "30 minutes neither saturates nor dies out" be checked on the CPU.
 */
export function driftStep(
  field: number,
  wash: number,
  dark: number,
  ring: number,
  ringMask: number,
  params: Pick<DriftParams, 'keep' | 'decay' | 'ringAlpha'>
): number {
  let warped = field + (dark - field) * params.decay
  const ringMix = params.ringAlpha * ringMask
  warped += (ring - warped) * ringMix
  return wash + (warped - wash) * params.keep
}

/** The ring's coverage at `distance` from its centre line, as the shader computes it. */
export function ringMask(distance: number, width: number): number {
  const edge0 = width * 0.4
  const x = (Math.abs(distance) - edge0) / (width - edge0)
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  return 1 - t * t * (3 - 2 * t)
}
