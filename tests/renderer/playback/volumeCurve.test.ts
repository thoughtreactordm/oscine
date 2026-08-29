import { describe, expect, it } from 'vitest'
import {
  amplitudeToPerceptualVolume,
  perceptualVolumeToAmplitude,
  VOLUME_TAPER_RANGE_DB
} from '../../../src/renderer/playback/volumeCurve'

describe('perceptualVolumeToAmplitude', () => {
  it('pins the endpoints to exact silence and unity', () => {
    expect(perceptualVolumeToAmplitude(0)).toBe(0)
    expect(perceptualVolumeToAmplitude(1)).toBe(1)
  })

  it('places the halfway slider at the middle of the dB range', () => {
    // Half travel is half the range in dB, i.e. -30 dB with a 60 dB taper.
    const expected = Math.pow(10, -VOLUME_TAPER_RANGE_DB / 2 / 20)
    expect(perceptualVolumeToAmplitude(0.5)).toBeCloseTo(expected, 12)
    expect(perceptualVolumeToAmplitude(0.5)).toBeCloseTo(0.0316227766, 9)
  })

  it('is monotonic across the slider', () => {
    let previous = -1
    for (let position = 0; position <= 1.0001; position += 0.01) {
      const amplitude = perceptualVolumeToAmplitude(position)
      expect(amplitude).toBeGreaterThan(previous)
      previous = amplitude
    }
  })

  it('stays a valid gain — finite and within [0, 1] — for every position', () => {
    for (let position = 0; position <= 1.0001; position += 0.005) {
      const amplitude = perceptualVolumeToAmplitude(position)
      expect(Number.isFinite(amplitude)).toBe(true)
      expect(amplitude).toBeGreaterThanOrEqual(0)
      expect(amplitude).toBeLessThanOrEqual(1)
    }
  })

  it('clamps out-of-range input and treats non-finite as silence', () => {
    expect(perceptualVolumeToAmplitude(-0.5)).toBe(0)
    expect(perceptualVolumeToAmplitude(2)).toBe(1)
    // Non-finite is a degenerate input that must never reach Web Audio; the
    // finite guard runs first, so even +Infinity resolves to silence.
    expect(perceptualVolumeToAmplitude(Number.NaN)).toBe(0)
    expect(perceptualVolumeToAmplitude(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('amplitudeToPerceptualVolume', () => {
  it('round-trips a slider position back to itself', () => {
    for (let position = 0; position <= 1.0001; position += 0.05) {
      const clamped = Math.min(position, 1)
      const back = amplitudeToPerceptualVolume(perceptualVolumeToAmplitude(clamped))
      expect(back).toBeCloseTo(clamped, 10)
    }
  })

  it('pins its own endpoints and rejects non-finite input', () => {
    expect(amplitudeToPerceptualVolume(0)).toBe(0)
    expect(amplitudeToPerceptualVolume(1)).toBe(1)
    expect(amplitudeToPerceptualVolume(-1)).toBe(0)
    expect(amplitudeToPerceptualVolume(Number.NaN)).toBe(0)
  })
})
