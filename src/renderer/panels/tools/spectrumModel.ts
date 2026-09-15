import {
  MAX_DISPLAY_FREQUENCY_HZ,
  MIN_DISPLAY_FREQUENCY_HZ,
  logFrequencyAt
} from '../../audio/eqResponse'

/**
 * The EQ pane's spectrum, as pure DSP over numbers — **W19-4 (spectrum overlay)**.
 *
 * The audio layer exposes only a time-domain read (`readWaveform`, −1..1) and
 * deliberately hides `AnalyserNode`, so there is no frequency data to ask for.
 * This turns that waveform into a magnitude spectrum in the renderer: a Hann
 * window, a radix-2 FFT, magnitudes to dB, then a peak-hold resample onto the
 * pane's log-frequency grid so it lines up with the curve exactly. The waveform
 * is tapped pre-EQ (at the crossfade gain, before the biquads), so this is the
 * raw track — the pane draws the curve's influence by adding the response dB on
 * top, rather than needing a second post-EQ tap.
 *
 * Nothing here imports Web Audio, `@renderer`, or the DOM: like `equalizerModel`
 * it is unit-tested under plain Node, so it reaches `eqResponse` by relative path
 * and keeps the axis mapping shared with the curve.
 */

const MIN_HZ = MIN_DISPLAY_FREQUENCY_HZ
const MAX_HZ = MAX_DISPLAY_FREQUENCY_HZ

/** The FFT size — matches `WAVEFORM_SAMPLE_COUNT`, the length `readWaveform` fills. */
export const SPECTRUM_FFT_SIZE = 1024

/** Display floor: quieter than this reads as the bottom of the plot. */
export const SPECTRUM_FLOOR_DB = -90
/** Display ceiling: a full-scale tone (~−6 dB per bin after window gain) sits near the top. */
export const SPECTRUM_CEIL_DB = -12

/** Hann's coherent gain is 0.5; undo it so a windowed tone reads at its true level. */
const WINDOW_GAIN_COMPENSATION = 2

/** A copy of `samples` under a Hann window, which tames the FFT's spectral leakage. */
export function applyHann(samples: Float32Array): Float32Array {
  const n = samples.length
  const out = new Float32Array(n)
  if (n <= 1) {
    out.set(samples)
    return out
  }
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    out[i] = samples[i] * w
  }
  return out
}

/** In-place iterative radix-2 Cooley-Tukey FFT; `re`/`im` must be a power-of-two length. */
function transformRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n <= 1) return
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wLenRe = Math.cos(angle)
    const wLenIm = Math.sin(angle)
    for (let start = 0; start < n; start += len) {
      let wRe = 1
      let wIm = 0
      const halfLen = len >> 1
      for (let k = 0; k < halfLen; k++) {
        const a = start + k
        const b = a + halfLen
        const tr = re[b] * wRe - im[b] * wIm
        const ti = re[b] * wIm + im[b] * wRe
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nextWRe = wRe * wLenRe - wIm * wLenIm
        wIm = wRe * wLenIm + wIm * wLenRe
        wRe = nextWRe
      }
    }
  }
}

/**
 * The single-sided magnitude spectrum of `samples`: `length / 2` linear
 * magnitudes, normalised so a full-scale bin reads ~1. Returns zeros for a
 * non-power-of-two length rather than a wrong transform.
 */
export function fftMagnitudes(samples: Float32Array): Float32Array {
  const n = samples.length
  const half = n >> 1
  if (n < 2 || (n & (n - 1)) !== 0) return new Float32Array(Math.max(0, half))
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = samples[i]
  transformRadix2(re, im)
  const mag = new Float32Array(half)
  for (let i = 0; i < half; i++) {
    mag[i] = (Math.hypot(re[i], im[i]) / n) * WINDOW_GAIN_COMPENSATION
  }
  return mag
}

/** A linear magnitude as dB, floored so silence is a number rather than `-Infinity`. */
export function magnitudeToDb(magnitude: number, floorDb = SPECTRUM_FLOOR_DB): number {
  if (!(magnitude > 0)) return floorDb
  return Math.max(floorDb, 20 * Math.log10(magnitude))
}

/**
 * Resample linear FFT bins onto the pane's log-frequency grid, peak-held.
 *
 * The FFT's bins are linearly spaced but the axis is logarithmic, so a low
 * display point covers a fraction of one bin while a high one spans dozens. Peak
 * (not mean) over each point's bin span is what a spectrum display wants — it
 * keeps a narrow tone visible instead of averaging it into its neighbours.
 */
export function resampleLogAxis(
  magnitudes: Float32Array,
  sampleRateHz: number,
  points: number,
  minHz = MIN_HZ,
  maxHz = MAX_HZ,
  floorDb = SPECTRUM_FLOOR_DB
): Float32Array {
  const out = new Float32Array(Math.max(0, points))
  if (out.length === 0 || magnitudes.length === 0 || sampleRateHz <= 0) {
    out.fill(floorDb)
    return out
  }
  const fftSize = magnitudes.length * 2
  const hzPerBin = sampleRateHz / fftSize
  const lastBin = magnitudes.length - 1
  for (let i = 0; i < out.length; i++) {
    const span = out.length === 1 ? 0 : 1 / (out.length - 1)
    const fLo = logFrequencyAt(Math.max(0, i / (out.length - 1) - span / 2), minHz, maxHz)
    const fHi = logFrequencyAt(Math.min(1, i / (out.length - 1) + span / 2), minHz, maxHz)
    let binLo = Math.floor(fLo / hzPerBin)
    let binHi = Math.ceil(fHi / hzPerBin)
    if (binLo < 0) binLo = 0
    if (binHi > lastBin) binHi = lastBin
    if (binHi < binLo) binHi = binLo
    let peak = 0
    for (let bin = binLo; bin <= binHi; bin++) if (magnitudes[bin] > peak) peak = magnitudes[bin]
    out[i] = magnitudeToDb(peak, floorDb)
  }
  return out
}

/** Window → FFT → dB → log-resample in one call: the dB spectrum on the pane's grid. */
export function spectrumFrameDb(
  samples: Float32Array,
  sampleRateHz: number,
  points: number,
  minHz = MIN_HZ,
  maxHz = MAX_HZ,
  floorDb = SPECTRUM_FLOOR_DB
): Float32Array {
  const magnitudes = fftMagnitudes(applyHann(samples))
  return resampleLogAxis(magnitudes, sampleRateHz, points, minHz, maxHz, floorDb)
}

/** Fast to rise, slow to fall — the standard spectrum feel, so peaks read and lulls linger. */
export interface SpectrumSmoother {
  /** Fold a fresh frame in and return the running values (dB), mutated in place. */
  push(frameDb: Float32Array): Float32Array
  /** Ease every point one step toward the floor — a paused track fading out. */
  decay(): Float32Array
  /** Whether anything is still above the floor and worth drawing. */
  active(): boolean
  /** Drop straight to the floor. */
  reset(): void
  /** The current values (dB). */
  readonly values: Float32Array
}

export function createSpectrumSmoother(
  points: number,
  { floorDb = SPECTRUM_FLOOR_DB, attack = 0.6, release = 0.16 } = {}
): SpectrumSmoother {
  const values = new Float32Array(Math.max(0, points)).fill(floorDb)

  function toward(target: (i: number) => number): Float32Array {
    for (let i = 0; i < values.length; i++) {
      const t = target(i)
      const rate = t > values[i] ? attack : release
      values[i] += (t - values[i]) * rate
    }
    return values
  }

  return {
    push: (frameDb) => toward((i) => frameDb[i] ?? floorDb),
    decay: () => toward(() => floorDb),
    active: () => {
      for (let i = 0; i < values.length; i++) if (values[i] > floorDb + 0.5) return true
      return false
    },
    reset: () => {
      values.fill(floorDb)
    },
    values
  }
}
