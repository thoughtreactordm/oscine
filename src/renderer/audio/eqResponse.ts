/**
 * The equalizer's magnitude response as pure functions over numbers — no nodes,
 * no context, no Vue. This is what the Tools pane draws (W19-4), and it is the
 * one place the curve is computed, so hit-testing and drawing cannot disagree.
 *
 * ## Why not `BiquadFilterNode.getFrequencyResponse()`
 *
 * It is right there and it is still the wrong source for the drawn curve: it
 * needs a live node in a live context, so the curve could not be drawn before
 * playback starts (the pane opens first), could not be unit-tested without Web
 * Audio, and would have to be re-read every drag frame from a node the audio
 * thread is also touching. A pure implementation lets the agreement between
 * picture and sound be asserted *once, as a test* (see `eqResponse.test.ts`)
 * rather than trusted on every frame — the same shape `equalPower.ts`,
 * `gaplessTiming.ts` and `normalization.ts` already have.
 *
 * ## These are Web Audio's coefficients, not the bare cookbook's
 *
 * The formulae are the RBJ Audio EQ Cookbook, but the drawn curve has to match
 * the `BiquadFilterNode` the router actually builds, and Web Audio makes two
 * choices that the naive cookbook does not:
 *
 *   - **`Q` is in dB for `lowpass`/`highpass`.** The node uses
 *     `α = sinω0 / (2·10^(Q/20))`, so a numeric `Q` of `1/√2` puts roughly
 *     `+0.7 dB` at the cutoff, *not* the textbook −3 dB. A −3 dB Butterworth
 *     knee is `Q ≈ −3.01` on this scale. Every other type reads `Q` linearly.
 *   - **Shelves ignore `Q` and fix the slope at `S = 1`**, which collapses the
 *     cookbook's shelf `α` to `(sinω0/2)·√2`.
 *
 * Evaluating `|H(e^jω)|` from these coefficients agrees with a real node to
 * ~1e-5 dB across every type, gain and the full clamp range of Q. Draw the
 * transfer function, never the "gain at centre" intuition — the shelf and
 * peaking forms diverge from it at low Q, and drawing the intuition is the
 * classic way for a curve to lie about the filter.
 */

import type { EqualizerBand, EqualizerSpec } from './equalizer'

/**
 * The x-axis the pane draws over: the audible band, 20 Hz – 20 kHz. Exported so
 * the pane and its hit-testing read the same endpoints as the curve.
 */
export const MIN_DISPLAY_FREQUENCY_HZ = 20
export const MAX_DISPLAY_FREQUENCY_HZ = 20000

/**
 * What to compute the curve at before playback has fixed a real rate. The pane
 * gets the live rate from the decoded context (`targetSampleRateHz`, W19-1) and
 * uses this only when nothing is playing yet — a named constant rather than a
 * `48000` buried at the call site. The curve genuinely depends on rate: the
 * bilinear transform warps the top octave, so a band near 20 kHz is a different
 * shape at 44.1 kHz and 96 kHz.
 */
export const FALLBACK_SAMPLE_RATE_HZ = 48000

/** A biquad's transfer function, normalised by `a0`: `1` is implicit as the leading denominator term. */
export interface BiquadCoefficients {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** The identity filter — `H(z) = 1`, flat at 0 dB. Returned for degenerate input. */
const IDENTITY_COEFFICIENTS: BiquadCoefficients = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }

/**
 * The RBJ coefficients for one band at a given sample rate, in Web Audio's
 * conventions (see the module comment), normalised by `a0`.
 *
 * `frequencyHz` is clamped to `[0, nyquist]` because that is the node's own
 * range and a value past Nyquist has no meaning; the ± gain and Q ranges are
 * left to the router and the settings validators, which own them, so this
 * agrees with the node for any value they let through. Non-finite input falls
 * back to the identity filter rather than poisoning the curve with NaN.
 */
export function biquadCoefficients(band: EqualizerBand, sampleRateHz: number): BiquadCoefficients {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return IDENTITY_COEFFICIENTS

  const nyquistHz = sampleRateHz / 2
  const f0 = Math.min(
    Math.max(Number.isFinite(band.frequencyHz) ? band.frequencyHz : 0, 0),
    nyquistHz
  )
  const gainDb = Number.isFinite(band.gainDb) ? band.gainDb : 0
  // Not floored positive: lowpass/highpass read Q in dB, where a negative value
  // is legitimate (a knee below the textbook −3 dB). A Q of 0 in the linear-α
  // types would divide by zero, but that surfaces as a non-finite coefficient
  // caught below, not as a silently wrong curve.
  const q = Number.isFinite(band.q) ? band.q : 1

  const w0 = (2 * Math.PI * f0) / sampleRateHz
  const cosW0 = Math.cos(w0)
  const sinW0 = Math.sin(w0)
  const a = Math.pow(10, gainDb / 40) // shelf/peaking amplitude; √(linear gain)

  const alphaLinear = sinW0 / (2 * q)
  const alphaDb = sinW0 / (2 * Math.pow(10, q / 20))
  const alphaShelf = (sinW0 / 2) * Math.SQRT2 // S = 1

  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  switch (band.type) {
    case 'lowpass':
      b0 = (1 - cosW0) / 2
      b1 = 1 - cosW0
      b2 = (1 - cosW0) / 2
      a0 = 1 + alphaDb
      a1 = -2 * cosW0
      a2 = 1 - alphaDb
      break
    case 'highpass':
      b0 = (1 + cosW0) / 2
      b1 = -(1 + cosW0)
      b2 = (1 + cosW0) / 2
      a0 = 1 + alphaDb
      a1 = -2 * cosW0
      a2 = 1 - alphaDb
      break
    case 'notch':
      b0 = 1
      b1 = -2 * cosW0
      b2 = 1
      a0 = 1 + alphaLinear
      a1 = -2 * cosW0
      a2 = 1 - alphaLinear
      break
    case 'lowshelf': {
      const tsa = 2 * Math.sqrt(a) * alphaShelf
      b0 = a * (a + 1 - (a - 1) * cosW0 + tsa)
      b1 = 2 * a * (a - 1 - (a + 1) * cosW0)
      b2 = a * (a + 1 - (a - 1) * cosW0 - tsa)
      a0 = a + 1 + (a - 1) * cosW0 + tsa
      a1 = -2 * (a - 1 + (a + 1) * cosW0)
      a2 = a + 1 + (a - 1) * cosW0 - tsa
      break
    }
    case 'highshelf': {
      const tsa = 2 * Math.sqrt(a) * alphaShelf
      b0 = a * (a + 1 + (a - 1) * cosW0 + tsa)
      b1 = -2 * a * (a - 1 + (a + 1) * cosW0)
      b2 = a * (a + 1 + (a - 1) * cosW0 - tsa)
      a0 = a + 1 - (a - 1) * cosW0 + tsa
      a1 = 2 * (a - 1 - (a + 1) * cosW0)
      a2 = a + 1 - (a - 1) * cosW0 - tsa
      break
    }
    case 'peaking':
    default:
      b0 = 1 + alphaLinear * a
      b1 = -2 * cosW0
      b2 = 1 - alphaLinear * a
      a0 = 1 + alphaLinear / a
      a1 = -2 * cosW0
      a2 = 1 - alphaLinear / a
      break
  }

  if (a0 === 0 || !Number.isFinite(a0)) return IDENTITY_COEFFICIENTS
  const coefficients = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
  for (const value of Object.values(coefficients)) {
    if (!Number.isFinite(value)) return IDENTITY_COEFFICIENTS
  }
  return coefficients
}

/**
 * `20·log10|H(e^jω)|` for one band's coefficients at `frequencyHz`.
 *
 * Evaluates the transfer function directly: `H(e^jω) = (b0 + b1 e^-jω + b2 e^-2jω)
 * / (1 + a1 e^-jω + a2 e^-2jω)`, whose squared magnitude is the ratio of the two
 * complex moduli. Returns 0 dB for a degenerate result so a broken band paints
 * flat rather than tearing a NaN through the curve.
 */
export function bandMagnitudeDb(
  coefficients: BiquadCoefficients,
  frequencyHz: number,
  sampleRateHz: number
): number {
  if (!Number.isFinite(frequencyHz) || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return 0

  const w = (2 * Math.PI * frequencyHz) / sampleRateHz
  const cosW = Math.cos(w)
  const cos2W = Math.cos(2 * w)
  const sinW = Math.sin(w)
  const sin2W = Math.sin(2 * w)

  const { b0, b1, b2, a1, a2 } = coefficients
  const numRe = b0 + b1 * cosW + b2 * cos2W
  const numIm = -(b1 * sinW + b2 * sin2W)
  const denRe = 1 + a1 * cosW + a2 * cos2W
  const denIm = -(a1 * sinW + a2 * sin2W)

  const numMagSq = numRe * numRe + numIm * numIm
  const denMagSq = denRe * denRe + denIm * denIm
  if (denMagSq === 0) return 0

  const db = 10 * Math.log10(numMagSq / denMagSq)
  return Number.isFinite(db) ? db : 0
}

/**
 * The composite response at a single frequency: preamp plus every enabled band.
 *
 * Magnitudes multiply, so **decibels add** — the composite is the sum of the
 * per-band dB contributions plus `preampDb`. A disabled spec, or a disabled
 * band, contributes nothing. A disabled spec is 0 dB everywhere regardless of
 * its bands, because a disabled EQ is bypassed to its dry path and passes the
 * signal through untouched (W19-1).
 */
export function specMagnitudeDb(
  spec: EqualizerSpec,
  frequencyHz: number,
  sampleRateHz: number
): number {
  if (!spec.enabled) return 0
  let db = Number.isFinite(spec.preampDb) ? spec.preampDb : 0
  for (const band of spec.bands) {
    if (!band.enabled) continue
    db += bandMagnitudeDb(biquadCoefficients(band, sampleRateHz), frequencyHz, sampleRateHz)
  }
  return Number.isFinite(db) ? db : 0
}

/**
 * The whole composite curve on a log-spaced grid — what the pane calls per
 * redraw. Coefficients are computed once per band and reused across the grid,
 * since they depend on the band and the rate, not on the evaluation frequency.
 */
export function responseCurveDb(
  spec: EqualizerSpec,
  sampleRateHz: number,
  points: number,
  minHz: number,
  maxHz: number
): Float32Array {
  const curve = new Float32Array(Math.max(0, points))
  if (!spec.enabled || curve.length === 0) return curve // all zeros: flat / bypassed

  const preampDb = Number.isFinite(spec.preampDb) ? spec.preampDb : 0
  const active = spec.bands
    .filter((band) => band.enabled)
    .map((band) => biquadCoefficients(band, sampleRateHz))

  for (let i = 0; i < curve.length; i++) {
    const fraction = curve.length === 1 ? 0 : i / (curve.length - 1)
    const frequencyHz = logFrequencyAt(fraction, minHz, maxHz)
    let db = preampDb
    for (const coefficients of active)
      db += bandMagnitudeDb(coefficients, frequencyHz, sampleRateHz)
    curve[i] = Number.isFinite(db) ? db : 0
  }
  return curve
}

/**
 * Points the headroom scan samples the composite over. Denser than the drawn
 * curve so a narrow boost peak sitting between two display points is not missed —
 * the whole job of this number is to find the maximum, and a coarse grid rounds
 * it down.
 */
const PREAMP_GRID_POINTS = 512

/**
 * The pre-amp that just cancels the loudest boost a curve makes: the negative of
 * the composite response's maximum over the audible grid, floored at 0 so Auto
 * never *boosts* (a cutting-only curve has no positive peak and needs none).
 *
 * Computed from the whole composite — R11's point — not from the largest single
 * band gain: two overlapping +4 dB peaks add to more than +4 dB where they meet,
 * and a max-band-gain shortcut would leave that summed peak clipping the output.
 * `responseCurveDb` is the one place the magnitude is evaluated, so this reads the
 * exact curve the pane draws and the router builds.
 *
 * The band composite is evaluated with the spec forced enabled and its own
 * pre-amp stripped, so the suggestion is a property of the *shape* alone. That is
 * what makes pressing Auto idempotent: it does not fold in the pre-amp already
 * set, so applying it and asking again returns the same value rather than
 * compounding toward silence.
 */
export function suggestedPreampDb(spec: EqualizerSpec, sampleRateHz: number): number {
  const shapeOnly: EqualizerSpec = { ...spec, enabled: true, preampDb: 0 }
  const curve = responseCurveDb(
    shapeOnly,
    sampleRateHz,
    PREAMP_GRID_POINTS,
    MIN_DISPLAY_FREQUENCY_HZ,
    MAX_DISPLAY_FREQUENCY_HZ
  )
  let peakDb = 0
  for (const db of curve) if (db > peakDb) peakDb = db
  // A flat or cutting-only curve has no positive peak, so this returns 0 — the
  // never-boost rule — and a boosting one returns the exact negative of its peak.
  // The `> 0` guard also keeps the flat case at +0 rather than -0.
  return peakDb > 0 ? -peakDb : 0
}

/**
 * The x-axis mapping, kept here rather than in the component so the pane's
 * hit-testing and the drawn curve cannot drift apart. `fraction` 0 → `minHz`,
 * 1 → `maxHz`, log-spaced between.
 */
export function logFrequencyAt(fraction: number, minHz: number, maxHz: number): number {
  const logMin = Math.log(minHz)
  const logMax = Math.log(maxHz)
  return Math.exp(logMin + fraction * (logMax - logMin))
}

/** The inverse of {@link logFrequencyAt}: which fraction of the axis a frequency sits at. */
export function fractionForFrequency(frequencyHz: number, minHz: number, maxHz: number): number {
  const logMin = Math.log(minHz)
  const logMax = Math.log(maxHz)
  return (Math.log(frequencyHz) - logMin) / (logMax - logMin)
}
