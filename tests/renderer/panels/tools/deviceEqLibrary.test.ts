import { describe, expect, it } from 'vitest'
import { EQUALIZER_BAND_LIMIT, parseEqualizerSpec } from '../../../../src/shared/audio/equalizer'
import {
  DEVICE_EQ_AUTOEQ_COMMIT,
  DEVICE_EQ_LIBRARY,
  DEVICE_EQ_SOURCE,
  deviceProfilePresetName,
  deviceProfileToSpec
} from '../../../../src/shared/audio/deviceEqLibrary'

/**
 * Guards the *committed* generated asset, not a fixture: every bundled device must
 * survive the same validator a stored curve does, or the picker would apply a spec
 * the router silently rejects. If a regenerated corpus ships a bad profile, this is
 * where it fails.
 */
describe('the bundled device EQ library', () => {
  it('bundles a substantial oratory1990 corpus pinned to a commit', () => {
    expect(DEVICE_EQ_LIBRARY.length).toBeGreaterThan(500)
    expect(DEVICE_EQ_AUTOEQ_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  it('has a unique id for every device', () => {
    const ids = new Set(DEVICE_EQ_LIBRARY.map((p) => p.id))
    expect(ids.size).toBe(DEVICE_EQ_LIBRARY.length)
  })

  it('round-trips every profile through parseEqualizerSpec', () => {
    for (const profile of DEVICE_EQ_LIBRARY) {
      const parsed = parseEqualizerSpec(profile.spec)
      expect(parsed, profile.name).not.toBeNull()
      expect(profile.spec.bands.length).toBeLessThanOrEqual(EQUALIZER_BAND_LIMIT)
    }
  })
})

describe('deviceProfileToSpec', () => {
  const profile = DEVICE_EQ_LIBRARY[0]

  it('mints a fresh id for every band, replacing the shared placeholders', () => {
    let n = 0
    const spec = deviceProfileToSpec(profile, () => `fresh-${n++}`)
    expect(spec.bands.map((b) => b.id)).toEqual(profile.spec.bands.map((_, i) => `fresh-${i}`))
    // Nothing else changes.
    expect(spec.preampDb).toBe(profile.spec.preampDb)
    expect(spec.enabled).toBe(profile.spec.enabled)
    expect(spec.bands.map((b) => b.frequencyHz)).toEqual(
      profile.spec.bands.map((b) => b.frequencyHz)
    )
  })

  it('defaults to real uuids that are unique per band', () => {
    const spec = deviceProfileToSpec(profile)
    const ids = new Set(spec.bands.map((b) => b.id))
    expect(ids.size).toBe(spec.bands.length)
    expect(ids.has('b0')).toBe(false)
  })
})

describe('deviceProfilePresetName', () => {
  it('offers the source-credited preset name', () => {
    const name = deviceProfilePresetName({
      id: 'x',
      name: 'Sennheiser HD 600',
      type: 'over-ear',
      spec: { enabled: true, preampDb: 0, bands: [] }
    })
    expect(name).toBe(`Sennheiser HD 600 (${DEVICE_EQ_SOURCE.measuredBy})`)
    expect(DEVICE_EQ_SOURCE.measuredBy).toBe('oratory1990')
  })
})
