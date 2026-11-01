import { describe, expect, it } from 'vitest'
import {
  auditRegistry,
  DEFAULT_VISUALIZER_EFFECT,
  getSetting,
  NOW_PLAYING_LYRICS_KEY,
  NOW_PLAYING_VISUALIZER_KEY,
  NOW_PLAYING_WAVEFORM_KEY,
  resolveSettings,
  settingsInCategory,
  VISUALIZER_CYCLE_KEY,
  VISUALIZER_EFFECT_KEY,
  VISUALIZER_IN_ZEN_KEY,
  VISUALIZER_QUALITY_KEY,
  type SettingDescriptor
} from '@shared/settings'

/**
 * W23-4, D35.5: the five stage-visualizer descriptors. The shapes here are
 * load-bearing — an unknown effect id that got rewritten would destroy an
 * operator's choice on a branch with fewer effects, and a portable quality key
 * would carry one machine's GPU budget to another.
 */
const KEYS = [
  NOW_PLAYING_VISUALIZER_KEY,
  VISUALIZER_IN_ZEN_KEY,
  VISUALIZER_EFFECT_KEY,
  VISUALIZER_CYCLE_KEY,
  VISUALIZER_QUALITY_KEY
]

function descriptorFor(key: string): SettingDescriptor {
  const descriptor = getSetting(key)
  if (!descriptor) throw new Error(`no descriptor for ${key}`)
  return descriptor
}

describe('the stage visualizer descriptors', () => {
  it('registers all five as durable interface keys with D35.5 defaults', () => {
    for (const key of KEYS) {
      expect(descriptorFor(key).category).toBe('interface')
      expect(descriptorFor(key).scope).toBe('durable')
    }
    expect(descriptorFor(NOW_PLAYING_VISUALIZER_KEY).default).toBe(false)
    expect(descriptorFor(VISUALIZER_IN_ZEN_KEY).default).toBe(false)
    expect(descriptorFor(VISUALIZER_EFFECT_KEY).default).toBe(DEFAULT_VISUALIZER_EFFECT)
    expect(descriptorFor(VISUALIZER_CYCLE_KEY).default).toBe('off')
    expect(descriptorFor(VISUALIZER_QUALITY_KEY).default).toBe('auto')
    expect(auditRegistry()).toEqual([])
  })

  it('keeps quality on the machine and everything else portable', () => {
    expect(descriptorFor(VISUALIZER_QUALITY_KEY).portable).toBe(false)
    for (const key of KEYS.filter((key) => key !== VISUALIZER_QUALITY_KEY)) {
      expect(descriptorFor(key).portable).toBe(true)
    }
  })

  it('sits after the ribbon and before lyrics on the settings surface', () => {
    const rows = settingsInCategory('interface').map((descriptor) => descriptor.key)
    const ribbon = rows.indexOf(NOW_PLAYING_WAVEFORM_KEY)
    expect(rows.slice(ribbon, ribbon + 5)).toEqual([
      NOW_PLAYING_WAVEFORM_KEY,
      NOW_PLAYING_VISUALIZER_KEY,
      VISUALIZER_IN_ZEN_KEY,
      VISUALIZER_CYCLE_KEY,
      VISUALIZER_QUALITY_KEY
    ])
    expect(rows[ribbon + 5]).toBe(NOW_PLAYING_LYRICS_KEY)
  })

  it('accepts an unknown effect id and preserves it', () => {
    const validate = descriptorFor(VISUALIZER_EFFECT_KEY).validate
    expect(validate('drift')).toEqual({ ok: true, value: 'drift' })
    expect(validate('some-effect-from-a-newer-branch')).toEqual({
      ok: true,
      value: 'some-effect-from-a-newer-branch'
    })

    const resolved = resolveSettings({ [VISUALIZER_EFFECT_KEY]: { value: 'drift', version: 1 } })
    expect(resolved.values[VISUALIZER_EFFECT_KEY]).toBe('drift')
    expect(resolved.notices).toEqual([])
    expect(resolved.rewrite).not.toContain(VISUALIZER_EFFECT_KEY)
  })

  it('rejects an empty or non-string effect id back to the default', () => {
    const validate = descriptorFor(VISUALIZER_EFFECT_KEY).validate
    expect(validate('').ok).toBe(false)
    expect(validate('   ').ok).toBe(false)
    expect(validate(3).ok).toBe(false)
    const resolved = resolveSettings({ [VISUALIZER_EFFECT_KEY]: { value: '', version: 1 } })
    expect(resolved.values[VISUALIZER_EFFECT_KEY]).toBe(DEFAULT_VISUALIZER_EFFECT)
  })

  it('validates the cycle and quality enums', () => {
    const cycle = descriptorFor(VISUALIZER_CYCLE_KEY).validate
    for (const value of ['off', 'track', 'shuffle']) expect(cycle(value).ok).toBe(true)
    expect(cycle('random').ok).toBe(false)

    const quality = descriptorFor(VISUALIZER_QUALITY_KEY).validate
    for (const value of ['auto', 'low', 'high']) expect(quality(value).ok).toBe(true)
    expect(quality('ultra').ok).toBe(false)
  })

  it('validates the two toggles as booleans', () => {
    for (const key of [NOW_PLAYING_VISUALIZER_KEY, VISUALIZER_IN_ZEN_KEY]) {
      const validate = descriptorFor(key).validate
      expect(validate(true).ok).toBe(true)
      expect(validate('yes').ok).toBe(false)
    }
  })
})
