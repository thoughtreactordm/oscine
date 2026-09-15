import { describe, expect, it } from 'vitest'
import {
  MAX_DISPLAY_FREQUENCY_HZ,
  MIN_DISPLAY_FREQUENCY_HZ,
  fractionForFrequency
} from '../../../../src/renderer/audio/eqResponse'
import {
  SPECTRUM_FFT_SIZE,
  SPECTRUM_FLOOR_DB,
  applyHann,
  createSpectrumSmoother,
  fftMagnitudes,
  magnitudeToDb,
  resampleLogAxis,
  spectrumFrameDb
} from '../../../../src/renderer/panels/tools/spectrumModel'

const RATE = 48000

function argmax(values: Float32Array): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i
  return best
}

function sine(frequencyHz: number, n = SPECTRUM_FFT_SIZE, rate = RATE): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * frequencyHz * i) / rate)
  return out
}

function displayIndex(frequencyHz: number, points: number): number {
  const fraction = fractionForFrequency(
    frequencyHz,
    MIN_DISPLAY_FREQUENCY_HZ,
    MAX_DISPLAY_FREQUENCY_HZ
  )
  return Math.round(fraction * (points - 1))
}

describe('applyHann', () => {
  it('is zero at the ends and unity in the middle', () => {
    const w = applyHann(new Float32Array(8).fill(1))
    expect(w[0]).toBeCloseTo(0, 6)
    expect(w[7]).toBeCloseTo(0, 6)
    expect(w[4]).toBeGreaterThan(0.9)
  })
})

describe('fftMagnitudes', () => {
  it('peaks at the bin of a bin-aligned sine', () => {
    // 64 cycles across 1024 samples lands exactly on bin 64.
    const samples = new Float32Array(SPECTRUM_FFT_SIZE)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 64 * i) / SPECTRUM_FFT_SIZE)
    }
    const mag = fftMagnitudes(samples)
    expect(mag).toHaveLength(SPECTRUM_FFT_SIZE / 2)
    expect(argmax(mag)).toBe(64)
    expect(mag[64]).toBeGreaterThan(0.9) // amplitude 1 after window-gain compensation
    expect(mag[32]).toBeLessThan(0.05)
  })

  it('puts a DC signal in bin 0', () => {
    expect(argmax(fftMagnitudes(new Float32Array(SPECTRUM_FFT_SIZE).fill(1)))).toBe(0)
  })

  it('returns zeros for a non-power-of-two length', () => {
    const mag = fftMagnitudes(new Float32Array(6).fill(1))
    expect(Array.from(mag)).toEqual([0, 0, 0])
  })
})

describe('magnitudeToDb', () => {
  it('maps unity to 0 dB, a tenth to −20 dB, and silence to the floor', () => {
    expect(magnitudeToDb(1)).toBeCloseTo(0, 6)
    expect(magnitudeToDb(0.1)).toBeCloseTo(-20, 6)
    expect(magnitudeToDb(0)).toBe(SPECTRUM_FLOOR_DB)
  })
})

describe('resampleLogAxis', () => {
  it('places energy at the display point matching its frequency, floor elsewhere', () => {
    const points = 256
    // One linear bin lit at ~1 kHz: bin = 1000 * 1024 / 48000 ≈ 21.
    const magnitudes = new Float32Array(SPECTRUM_FFT_SIZE / 2)
    magnitudes[21] = 1
    const out = resampleLogAxis(magnitudes, RATE, points)

    expect(out[displayIndex(1000, points)]).toBeGreaterThan(-3)
    expect(out[displayIndex(5000, points)]).toBe(SPECTRUM_FLOOR_DB)
  })
})

describe('spectrumFrameDb', () => {
  it('lifts the display near a played tone well above the floor', () => {
    const points = 256
    const out = spectrumFrameDb(sine(1000), RATE, points)
    expect(out[displayIndex(1000, points)]).toBeGreaterThan(SPECTRUM_FLOOR_DB + 30)
  })
})

describe('createSpectrumSmoother', () => {
  it('rises with a frame, decays to the floor, and reports activity', () => {
    const smoother = createSpectrumSmoother(4)
    expect(smoother.active()).toBe(false)

    smoother.push(new Float32Array([-20, -20, -20, -20]))
    expect(smoother.active()).toBe(true)
    expect(smoother.values[0]).toBeGreaterThan(SPECTRUM_FLOOR_DB)

    for (let i = 0; i < 200; i++) smoother.decay()
    expect(smoother.active()).toBe(false)
  })

  it('reset drops straight to the floor', () => {
    const smoother = createSpectrumSmoother(3)
    smoother.push(new Float32Array([0, 0, 0]))
    smoother.reset()
    expect(smoother.active()).toBe(false)
  })
})
