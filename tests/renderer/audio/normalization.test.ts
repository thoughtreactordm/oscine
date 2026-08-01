import { describe, expect, it } from 'vitest'
import type { TrackReplayGain } from '../../../src/shared/library'
import {
  dbToLinear,
  normalizationPolicyForMode,
  resolveNormalization,
  type NormalizationPolicy
} from '../../../src/renderer/audio/normalization'

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
      normalizationPolicyForMode('track')
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
    const decision = resolveNormalization(
      gain({ rgTrackGainDb: -6, rgTrackPeak: 1.2 }),
      normalizationPolicyForMode('track')
    )

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

    expect(resolveNormalization(values, normalizationPolicyForMode('album'))).toMatchObject({
      field: 'album',
      gainDb: -4,
      peak: 0.95
    })
    expect(
      resolveNormalization({ ...values, rgAlbumGainDb: null }, normalizationPolicyForMode('album'))
    ).toMatchObject({
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
      normalizationPolicyForMode('album')
    )

    expect(decision).toMatchObject({ field: 'album', gainDb: -5, peak: null })
    expect(decision.effectiveGain).toBeCloseTo(dbToLinear(-5))
  })

  it('returns unity for disabled mode and absent gain', () => {
    expect(
      resolveNormalization(gain({ rgTrackGainDb: -9 }), normalizationPolicyForMode('off'))
    ).toMatchObject({
      field: null,
      effectiveGain: 1
    })
    expect(
      resolveNormalization(gain({ rgTrackPeak: 0.8 }), normalizationPolicyForMode('track'))
    ).toMatchObject({
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
      const decision = resolveNormalization(values, normalizationPolicyForMode('track'))
      expect(Number.isFinite(decision.effectiveGain)).toBe(true)
      expect(decision.effectiveGain).toBeGreaterThanOrEqual(0)
    }
  })
})

/**
 * The two dB offsets W8-9 moved out of nowhere in particular and into
 * `audio.replayGainPreampDb` and `audio.replayGainFallbackDb`.
 *
 * They are separate knobs on purpose, and these assertions are what says so:
 * the pre-amp moves tracks that have a measurement and the fallback moves the
 * ones that do not, so raising one and raising the other pull in opposite
 * directions on the gap between tagged and untagged material. Folding either
 * into the other would make that gap impossible to close.
 */
describe('the ReplayGain offsets', () => {
  function policy(overrides: Partial<NormalizationPolicy> = {}): NormalizationPolicy {
    return { ...normalizationPolicyForMode('track'), ...overrides }
  }

  it('adds the pre-amp to a track that has a measurement', () => {
    const decision = resolveNormalization(
      gain({ rgTrackGainDb: -6, rgSource: 'tag' }),
      policy({ preampDb: 3 })
    )

    expect(decision.gainDb).toBe(-6)
    expect(decision.requestedGainDb).toBe(-3)
    expect(decision.effectiveGain).toBeCloseTo(dbToLinear(-3))
  })

  it('peak-limits the pre-amp exactly as it limits a measurement', () => {
    // Asking for headroom is not the same as taking it: the known peak still
    // decides how much of the pre-amp survives.
    const decision = resolveNormalization(
      gain({ rgTrackGainDb: 0, rgTrackPeak: 0.8 }),
      policy({ preampDb: 6 })
    )

    expect(decision.requestedGainDb).toBe(6)
    expect(decision.peakLimited).toBe(true)
    expect(decision.effectiveGain).toBeCloseTo(1.25)
  })

  it('applies the fallback to a track with no measurement', () => {
    const decision = resolveNormalization(gain({ rgSource: null }), policy({ fallbackGainDb: -4 }))

    expect(decision.gainDb).toBeNull()
    expect(decision.requestedGainDb).toBe(-4)
    expect(decision.effectiveGain).toBeCloseTo(dbToLinear(-4))
  })

  it('does not add the pre-amp on top of the fallback', () => {
    // The fallback *is* the untagged track's answer to "how loud", so the two
    // never compound. An operator raising the pre-amp is moving tagged tracks
    // relative to untagged ones, which only works if this holds.
    const decision = resolveNormalization(gain(), policy({ preampDb: 6, fallbackGainDb: -4 }))

    expect(decision.requestedGainDb).toBe(-4)
  })

  it('ignores both offsets when levelling is off', () => {
    const decision = resolveNormalization(
      gain({ rgTrackGainDb: -6 }),
      policy({ mode: 'off', preampDb: 6, fallbackGainDb: -4 })
    )

    expect(decision).toMatchObject({ field: null, requestedGainDb: 0, effectiveGain: 1 })
  })

  it('treats a non-finite offset as no offset rather than as silence', () => {
    const withPreamp = resolveNormalization(
      gain({ rgTrackGainDb: -6 }),
      policy({ preampDb: Number.NaN })
    )
    const withFallback = resolveNormalization(
      gain(),
      policy({ fallbackGainDb: Number.POSITIVE_INFINITY })
    )

    expect(withPreamp.requestedGainDb).toBe(-6)
    expect(withFallback.requestedGainDb).toBe(0)
    expect(withFallback.effectiveGain).toBe(1)
  })
})
