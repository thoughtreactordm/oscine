import { describe, expect, it } from 'vitest'
import { migrateValue, SETTINGS_REGISTRY, type SettingDescriptor } from '@shared/settings'
import { DEFAULT_THEME_ID, LEGACY_DEFAULT_THEME_ID } from '@shared/theme'

/**
 * The `theme.name` upgrade across the Fermata → Oscine rename.
 *
 * The default theme kept its ramps and moved only its id, so a profile that
 * stored the old id must resolve to the new one rather than fall through
 * `findTheme` and report the theme missing. Every other stored id — the other
 * built-ins, and a custom id this build does not ship — has to survive
 * untouched, because that is the rule a theme rename must not break: a build
 * that lacks a theme renders the default without deleting the operator's choice.
 */

const themeName = SETTINGS_REGISTRY.find(
  (descriptor) => descriptor.key === 'theme.name'
) as SettingDescriptor<string>

function migrate(value: unknown, version = 1): { value: string; changed: boolean } {
  const resolved = migrateValue(themeName, { value, version })
  return { value: resolved.value, changed: resolved.changed }
}

describe('theme.name across the rename', () => {
  it('is at version 2, the first shipped key to need an upgrade', () => {
    expect(themeName.version).toBe(2)
  })

  it('rewrites the pre-rename default id to the current one', () => {
    const result = migrate(LEGACY_DEFAULT_THEME_ID)
    expect(result.value).toBe(DEFAULT_THEME_ID)
    expect(result.changed).toBe(true)
  })

  it('leaves another built-in id alone', () => {
    expect(migrate('nocturne').value).toBe('nocturne')
  })

  it('leaves a custom id this build does not ship alone, rather than deleting it', () => {
    expect(migrate('someones-custom-theme').value).toBe('someones-custom-theme')
  })

  it('defaults a profile that never stored one to the new id', () => {
    expect(themeName.default).toBe(DEFAULT_THEME_ID)
    expect(DEFAULT_THEME_ID).toBe('oscine')
  })
})
