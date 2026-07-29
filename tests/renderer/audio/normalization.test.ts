import { describe, expect, it } from 'vitest'
import type { TrackReplayGain } from '../../../src/shared/library'
import { dbToLinear, resolveNormalization } from '../../../src/renderer/audio/normalization'

function gain(overrides: Partial<TrackReplayGain> = {}): TrackReplayGain {
  return {
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

describe('ReplayGain normalization policy', () => {
  it('converts positive and negative decibel values to linear amplitude', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.501187)
    expect(dbToLinear(6)).toBeCloseTo(1.995262)
    expect(dbToLinear(0)).toBe(1)
  })

  it('limits positive gain with the corresponding known peak', () => {
    const decision = resolveNormalization(
      gain({ rgTrackGainDb: 6, rgTrackPeak: 0.8, rgSource: 'tag' }),
      'track'
    )

    expect(decision).toMatchObject({
      field: 'track',
      source: 'tag',
      peakLimited: true
    })
    expect(decision.effectiveGain).toBeCloseTo(1.25)
    expect(decision.effectiveGain * 0.8).toBeCloseTo(1)
  })

  it('does not attenuate further when the requested gain is already below the peak ceiling', () => {
    const decision = resolveNormalization(gain({ rgTrackGainDb: -6, rgTrackPeak: 1.2 }), 'track')

    expect(decision.effectiveGain).toBeCloseTo(0.501187)
    expect(decision.peakLimited).toBe(false)
  })

  it('uses album values when present and falls back to the track pair when absent', () => {
    const values = gain({
      rgTrackGainDb: -7,
      rgTrackPeak: 0.9,
      rgAlbumGainDb: -4,
      rgAlbumPeak: 0.95
    })

    expect(resolveNormalization(values, 'album')).toMatchObject({
      field: 'album',
      gainDb: -4,
      peak: 0.95
    })
    expect(resolveNormalization({ ...values, rgAlbumGainDb: null }, 'album')).toMatchObject({
      field: 'track',
      gainDb: -7,
      peak: 0.9
    })
  })

  it('keeps partial tag sets instead of mixing unrelated gain and peak fields', () => {
    const decision = resolveNormalization(
      gain({
        rgTrackGainDb: -8,
        rgTrackPeak: 0.7,
        rgAlbumGainDb: -5,
        rgAlbumPeak: null
      }),
      'album'
    )

    expect(decision).toMatchObject({ field: 'album', gainDb: -5, peak: null })
    expect(decision.effectiveGain).toBeCloseTo(dbToLinear(-5))
  })

  it('returns unity for disabled mode and absent gain', () => {
    expect(resolveNormalization(gain({ rgTrackGainDb: -9 }), 'off')).toMatchObject({
      field: null,
      effectiveGain: 1
    })
    expect(resolveNormalization(gain({ rgTrackPeak: 0.8 }), 'track')).toMatchObject({
      field: 'track',
      gainDb: null,
      effectiveGain: 1
    })
  })

  it('never returns a non-finite AudioParam value for malformed inputs', () => {
    for (const values of [
      gain({ rgTrackGainDb: Number.NaN, rgTrackPeak: Number.POSITIVE_INFINITY }),
      gain({ rgTrackGainDb: Number.POSITIVE_INFINITY, rgTrackPeak: -1 }),
      gain({ rgTrackGainDb: Number.MAX_VALUE, rgTrackPeak: 0 })
    ]) {
      const decision = resolveNormalization(values, 'track')
      expect(Number.isFinite(decision.effectiveGain)).toBe(true)
      expect(decision.effectiveGain).toBeGreaterThanOrEqual(0)
    }
  })
})
