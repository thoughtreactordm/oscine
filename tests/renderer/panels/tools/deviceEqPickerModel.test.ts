import { describe, expect, it } from 'vitest'
import type { EqualizerSpec } from '../../../../src/shared/audio/equalizer'
import type { DeviceEqProfile } from '../../../../src/shared/audio/deviceEqLibrary'
import {
  filterDeviceProfiles,
  queryTerms
} from '../../../../src/renderer/panels/tools/deviceEqPickerModel'

const SPEC: EqualizerSpec = { enabled: true, preampDb: 0, bands: [] }

function profile(name: string, type: DeviceEqProfile['type'] = 'over-ear'): DeviceEqProfile {
  return { id: name.toLowerCase().replace(/\s+/g, '-'), name, type, spec: SPEC }
}

const LIBRARY: DeviceEqProfile[] = [
  profile('Sennheiser HD 600'),
  profile('Sennheiser HD 650'),
  profile('Sony WH-1000XM4'),
  profile('Sony WH-1000XM5'),
  profile('Moondrop Blessing 2 (Dusk)', 'in-ear'),
  profile('AKG K240 Sextett (Dekoni earpads)')
]

describe('queryTerms', () => {
  it('splits on whitespace and lower-cases', () => {
    expect(queryTerms('  Sony  XM5 ')).toEqual(['sony', 'xm5'])
  })

  it('is empty for a blank query', () => {
    expect(queryTerms('   ')).toEqual([])
  })
})

describe('filterDeviceProfiles', () => {
  it('returns a fresh copy of the whole library for a blank query', () => {
    const all = filterDeviceProfiles(LIBRARY, '  ')
    expect(all).toHaveLength(LIBRARY.length)
    expect(all).not.toBe(LIBRARY)
    expect(all).toEqual(LIBRARY)
  })

  it('requires every whitespace-separated term to appear (AND)', () => {
    const names = filterDeviceProfiles(LIBRARY, 'sony xm5').map((p) => p.name)
    expect(names).toEqual(['Sony WH-1000XM5'])
  })

  it('matches case-insensitively across the name', () => {
    const names = filterDeviceProfiles(LIBRARY, 'HD 6').map((p) => p.name)
    expect(names).toEqual(['Sennheiser HD 600', 'Sennheiser HD 650'])
  })

  it('excludes a device when any term is absent', () => {
    expect(filterDeviceProfiles(LIBRARY, 'sony hd')).toEqual([])
  })

  it('ranks an earlier match ahead of one buried later in the name', () => {
    const lib = [profile('Dekoni Blue'), profile('AKG K371 (Dekoni pads)'), profile('Dekoni Aeon')]
    const names = filterDeviceProfiles(lib, 'dekoni').map((p) => p.name)
    // The two names starting with "Dekoni" come before the one where it is a suffix.
    expect(names[2]).toBe('AKG K371 (Dekoni pads)')
  })

  it('breaks a score tie toward the shorter name', () => {
    const lib = [profile('Blessing 2 Dusk Edition'), profile('Blessing 2')]
    const names = filterDeviceProfiles(lib, 'blessing').map((p) => p.name)
    expect(names).toEqual(['Blessing 2', 'Blessing 2 Dusk Edition'])
  })
})
