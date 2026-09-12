import { describe, expect, it } from 'vitest'
import {
  AUDIO_EQ_ACTIVE,
  AUDIO_EQ_ENABLED,
  AUDIO_EQ_PRESETS,
  clampSetting,
  migrateValue
} from '@shared/settings'
import {
  EQUALIZER_BAND_LIMIT,
  FLAT_EQUALIZER_SPEC,
  parseEqualizerBand,
  parseEqualizerPreset,
  parseEqualizerPresets,
  parseEqualizerSpec,
  type EqualizerBand,
  type EqualizerPreset,
  type EqualizerSpec
} from '@shared/audio/equalizer'

function band(overrides: Partial<EqualizerBand> = {}): EqualizerBand {
  return {
    id: 'b1',
    type: 'peaking',
    frequencyHz: 1000,
    gainDb: 6,
    q: 1,
    enabled: true,
    ...overrides
  }
}

function spec(overrides: Partial<EqualizerSpec> = {}): EqualizerSpec {
  return { enabled: true, preampDb: -3, bands: [band()], ...overrides }
}

function preset(overrides: Partial<EqualizerPreset> = {}): EqualizerPreset {
  return { id: 'p1', name: 'Bass boost', spec: spec(), ...overrides }
}

describe('parseEqualizerSpec', () => {
  it('accepts a well-formed spec unchanged', () => {
    expect(parseEqualizerSpec(spec())).toEqual(spec())
  })

  it('accepts the flat default — the descriptor depends on this fixed point', () => {
    expect(parseEqualizerSpec(FLAT_EQUALIZER_SPEC)).toEqual({
      enabled: false,
      preampDb: 0,
      bands: []
    })
  })

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', []],
    ['a missing enabled', { preampDb: 0, bands: [] }],
    ['a non-boolean enabled', { enabled: 'yes', preampDb: 0, bands: [] }],
    ['a missing bands', { enabled: false, preampDb: 0 }],
    ['a non-array bands', { enabled: false, preampDb: 0, bands: {} }]
  ])('rejects %s by returning null', (_label, raw) => {
    expect(parseEqualizerSpec(raw)).toBeNull()
  })

  it('rejects a thirteen-band spec rather than truncating it', () => {
    const bands = Array.from({ length: EQUALIZER_BAND_LIMIT + 1 }, (_, i) => band({ id: `b${i}` }))
    expect(parseEqualizerSpec(spec({ bands }))).toBeNull()
  })

  it('accepts a spec at exactly the band limit', () => {
    const bands = Array.from({ length: EQUALIZER_BAND_LIMIT }, (_, i) => band({ id: `b${i}` }))
    expect(parseEqualizerSpec(spec({ bands }))?.bands).toHaveLength(EQUALIZER_BAND_LIMIT)
  })

  it('clamps out-of-range but finite numbers rather than rejecting them', () => {
    const parsed = parseEqualizerSpec(
      spec({ preampDb: 400, bands: [band({ gainDb: 400, frequencyHz: 5, q: 99 })] })
    )
    expect(parsed?.preampDb).toBe(24)
    expect(parsed?.bands[0]).toMatchObject({ gainDb: 24, frequencyHz: 20, q: 18 })
  })

  it('clamps negatives to the low end of each range', () => {
    const parsed = parseEqualizerSpec(
      spec({ preampDb: -400, bands: [band({ gainDb: -400, q: 0.001 })] })
    )
    expect(parsed?.preampDb).toBe(-24)
    expect(parsed?.bands[0]).toMatchObject({ gainDb: -24, q: 0.1 })
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY]
  ])('rejects a %s gain outright rather than clamping it', (_label, value) => {
    expect(parseEqualizerSpec(spec({ bands: [band({ gainDb: value })] }))).toBeNull()
    expect(parseEqualizerSpec(spec({ preampDb: value }))).toBeNull()
  })
})

describe('parseEqualizerBand', () => {
  it.each([
    ['an empty id', band({ id: '' })],
    ['a missing id', { type: 'peaking', frequencyHz: 1000, gainDb: 0, q: 1, enabled: true }],
    ['an unknown type', band({ type: 'bandpass' as EqualizerBand['type'] })],
    ['a non-boolean enabled', { ...band(), enabled: 1 }]
  ])('rejects %s', (_label, raw) => {
    expect(parseEqualizerBand(raw)).toBeNull()
  })
})

describe('parseEqualizerPresets', () => {
  it('accepts an array of well-formed presets, ids and all', () => {
    const presets = [preset(), preset({ id: 'p2', name: 'Vocal' })]
    expect(parseEqualizerPresets(presets)).toEqual(presets)
  })

  it('returns null for a non-array', () => {
    expect(parseEqualizerPresets({})).toBeNull()
    expect(parseEqualizerPresets('nope')).toBeNull()
  })

  it('drops a malformed preset but keeps the rest', () => {
    const good = preset()
    const parsed = parseEqualizerPresets([good, { id: '', name: 'broken', spec: spec() }, 42])
    expect(parsed).toEqual([good])
  })

  it('drops a preset whose spec is malformed', () => {
    const good = preset()
    const parsed = parseEqualizerPresets([good, { id: 'p2', name: 'X', spec: { enabled: false } }])
    expect(parsed).toEqual([good])
  })

  it('allows two presets with the same name', () => {
    const both = [preset({ id: 'p1', name: 'Car' }), preset({ id: 'p2', name: 'Car' })]
    expect(parseEqualizerPresets(both)).toHaveLength(2)
  })
})

describe('parseEqualizerPreset', () => {
  it.each([
    ['an empty id', preset({ id: '' })],
    ['a non-string name', { id: 'p1', name: 5, spec: spec() }],
    ['a missing spec', { id: 'p1', name: 'X' }]
  ])('rejects %s', (_label, raw) => {
    expect(parseEqualizerPreset(raw)).toBeNull()
  })
})

describe('the equalizer descriptors', () => {
  it('default to a flat, disabled, preset-free equalizer', () => {
    expect(AUDIO_EQ_ENABLED.default).toBe(false)
    expect(AUDIO_EQ_ACTIVE.default).toEqual({ enabled: false, preampDb: 0, bands: [] })
    expect(AUDIO_EQ_PRESETS.default).toEqual([])
  })

  it('are versioned at 1, internal, and portable so they ride the export bundle', () => {
    for (const descriptor of [AUDIO_EQ_ENABLED, AUDIO_EQ_ACTIVE, AUDIO_EQ_PRESETS]) {
      expect(descriptor.version).toBe(1)
      expect(descriptor.internal).toBe(true)
      expect(descriptor.portable).toBe(true)
    }
  })

  it('fall back to the default on a structurally broken active spec', () => {
    expect(clampSetting(AUDIO_EQ_ACTIVE, 'not a spec')).toEqual(AUDIO_EQ_ACTIVE.default)
    const bands = Array.from({ length: EQUALIZER_BAND_LIMIT + 1 }, (_, i) => band({ id: `b${i}` }))
    expect(clampSetting(AUDIO_EQ_ACTIVE, spec({ bands }))).toEqual(AUDIO_EQ_ACTIVE.default)
  })

  it('clamp an out-of-range active spec rather than dropping it', () => {
    const clamped = clampSetting(AUDIO_EQ_ACTIVE, spec({ bands: [band({ gainDb: 999 })] }))
    expect(clamped.bands[0]?.gainDb).toBe(24)
  })

  it('reject a NaN gain to the default rather than clamping it', () => {
    expect(clampSetting(AUDIO_EQ_ACTIVE, spec({ bands: [band({ gainDb: Number.NaN })] }))).toEqual(
      AUDIO_EQ_ACTIVE.default
    )
  })

  it('fall back to the empty array on a non-array presets blob', () => {
    expect(clampSetting(AUDIO_EQ_PRESETS, 'nope')).toEqual([])
  })

  it('round-trip presets through a stored blob, ids preserved', () => {
    const presets = [preset({ id: 'keep-me' }), preset({ id: 'and-me', name: 'Vocal' })]
    const resolved = migrateValue(AUDIO_EQ_PRESETS, { value: presets, version: 1 })
    expect(resolved.value).toEqual(presets)
    expect(resolved.value.map((p) => p.id)).toEqual(['keep-me', 'and-me'])
  })
})
