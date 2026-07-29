import { describe, expect, it } from 'vitest'
import {
  analyzePcm,
  gainFromHistogram,
  mergeHistograms
} from '../../../src/main/replaygain/loudness'

function sine(amplitude: number, seconds = 2, sampleRate = 48_000): Float32Array {
  const samples = new Float32Array(seconds * sampleRate)
  for (let index = 0; index < samples.length; index++) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * 1000 * index) / sampleRate)
  }
  return samples
}

describe('ReplayGain 2.0 loudness analysis', () => {
  it('tracks a deterministic 6.0206 dB amplitude change within 0.1 dB', () => {
    const quiet = analyzePcm([sine(0.1)], 48_000)
    const loud = analyzePcm([sine(0.2)], 48_000)

    expect(quiet.trackGainDb - loud.trackGainDb).toBeCloseTo(6.0206, 1)
    expect(quiet.trackPeak).toBeCloseTo(0.1, 5)
    expect(loud.trackPeak).toBeCloseTo(0.2, 5)
  })

  it('derives album gain from the retained gated-block histograms', () => {
    const quiet = analyzePcm([sine(0.1)], 48_000)
    const loud = analyzePcm([sine(0.2)], 48_000)
    const albumGain = gainFromHistogram(mergeHistograms([quiet.histogram, loud.histogram]))

    expect(albumGain).not.toBeNull()
    expect(albumGain!).toBeLessThan(quiet.trackGainDb)
    expect(albumGain!).toBeGreaterThan(loud.trackGainDb)
  })

  it('rejects silence instead of persisting a meaningless gain', () => {
    expect(() => analyzePcm([new Float32Array(48_000)], 48_000)).toThrow(/silent/i)
  })
})
