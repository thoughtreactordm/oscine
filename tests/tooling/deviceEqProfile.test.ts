import { describe, expect, it } from 'vitest'
import { parseEqualizerSpec } from '../../src/shared/audio/equalizer'
import { buildDeviceEqProfile, slugifyDeviceId } from '../../scripts/lib/deviceEqProfile'

/**
 * The build-time transform behind `scripts/build-device-eq-library.ts`, tested off
 * the network on fixture `ParametricEQ.txt` text — the same guarantee the parser it
 * reuses (W19-8) has, so a regenerated corpus cannot ship a profile that would not
 * have parsed.
 */
const HD600 = `Preamp: -6.7 dB
Filter 1: ON PK Fc 105 Hz Gain 5.5 dB Q 0.70
Filter 2: ON LSC Fc 105 Hz Gain 2.0 dB Q 0.70
Filter 3: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70`

describe('slugifyDeviceId', () => {
  it('lower-cases, strips punctuation, and hyphenates', () => {
    expect(slugifyDeviceId('Sennheiser HD 600')).toBe('sennheiser-hd-600')
    expect(slugifyDeviceId('AKG K240 (Dekoni pads)')).toBe('akg-k240-dekoni-pads')
  })

  it('folds diacritics rather than dropping the letter', () => {
    expect(slugifyDeviceId('Fostex TÉ')).toBe('fostex-te')
  })

  it('never yields an empty id', () => {
    expect(slugifyDeviceId('///')).toBe('device')
  })
})

describe('buildDeviceEqProfile', () => {
  it('builds a parseable profile with deterministic band ids', () => {
    const profile = buildDeviceEqProfile('Sennheiser HD 600', 'over-ear', HD600)
    expect(profile).not.toBeNull()
    expect(profile!.id).toBe('sennheiser-hd-600')
    expect(profile!.name).toBe('Sennheiser HD 600')
    expect(profile!.type).toBe('over-ear')
    expect(profile!.spec.preampDb).toBeCloseTo(-6.7, 5)
    expect(profile!.spec.bands.map((b) => b.id)).toEqual(['b0', 'b1', 'b2'])
    // The generated spec must satisfy the same validator the runtime loads it through.
    expect(parseEqualizerSpec(profile!.spec)).not.toBeNull()
  })

  it('returns null for text with no preamp and no recognizable filter', () => {
    expect(buildDeviceEqProfile('Nothing', 'in-ear', 'not a profile')).toBeNull()
    expect(buildDeviceEqProfile('Empty', 'earbud', '')).toBeNull()
  })
})
