import { describe, expect, it } from 'vitest'
import { SETTINGS_REGISTRY } from '@shared/settings'
import {
  buildThemeFile,
  parseThemeFile,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  type ThemeFile,
  type ThemeOverrides
} from '@shared/theme'

/**
 * The `.osctheme` format: what a theme becomes on disk, and what surviving the
 * round trip means.
 *
 * The rules mirror `parseSettingsProfile`'s — strict about the envelope,
 * forgiving about the payload — so the tests do the same: prove the envelope is
 * refused when wrong, prove the payload is repaired rather than rejected, and
 * prove a file this build wrote is one it reads back unchanged.
 */

const overrides: ThemeOverrides = {
  'color.accent': { mode: 'palette', palette: 'amber' },
  'font.body': 'Inter'
}

describe('buildThemeFile', () => {
  it('stamps the current format and version and trims the name', () => {
    const file = buildThemeFile({
      name: '  Dusk  ',
      base: 'oscine',
      mode: 'dark',
      overrides
    })
    expect(file.format).toBe(THEME_FILE_FORMAT)
    expect(file.formatVersion).toBe(THEME_FILE_VERSION)
    expect(file.name).toBe('Dusk')
    expect(file.base).toBe('oscine')
    expect(file.mode).toBe('dark')
    expect(file.overrides).toEqual(overrides)
  })

  it('omits app and exportedAt when not given', () => {
    const file = buildThemeFile({ name: 'Dusk', base: 'oscine', mode: 'system', overrides: {} })
    expect('app' in file).toBe(false)
    expect('exportedAt' in file).toBe(false)
  })
})

describe('parseThemeFile', () => {
  it('reads a file buildThemeFile wrote back unchanged', () => {
    const built = buildThemeFile({
      name: 'Dusk',
      base: 'nocturne',
      mode: 'light',
      overrides,
      app: '1.0.1',
      exportedAt: '2026-09-09T00:00:00.000Z'
    })
    const round = JSON.parse(JSON.stringify(built)) as unknown
    const parsed = parseThemeFile(round)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.themeFile).toEqual(built)
  })

  it('rejects a non-object', () => {
    expect(parseThemeFile(null).ok).toBe(false)
    expect(parseThemeFile('nope').ok).toBe(false)
    expect(parseThemeFile([]).ok).toBe(false)
  })

  it('rejects the wrong format marker', () => {
    const parsed = parseThemeFile({
      format: 'oscine.settings',
      formatVersion: 1,
      name: 'x',
      base: 'oscine'
    })
    expect(parsed.ok).toBe(false)
  })

  it('refuses a file from a newer build rather than reading it optimistically', () => {
    const parsed = parseThemeFile({
      format: THEME_FILE_FORMAT,
      formatVersion: THEME_FILE_VERSION + 1,
      name: 'x',
      base: 'oscine'
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('newer version')
  })

  it('requires a non-empty name and base', () => {
    const base = { format: THEME_FILE_FORMAT, formatVersion: 1, base: 'oscine' }
    expect(parseThemeFile({ ...base, name: '   ' }).ok).toBe(false)
    expect(
      parseThemeFile({ format: THEME_FILE_FORMAT, formatVersion: 1, name: 'x', base: '' }).ok
    ).toBe(false)
  })

  it('falls back to system for an unknown mode rather than failing', () => {
    const parsed = parseThemeFile({
      format: THEME_FILE_FORMAT,
      formatVersion: 1,
      name: 'x',
      base: 'oscine',
      mode: 'sepia'
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.themeFile.mode).toBe('system')
  })

  it('runs overrides through the tolerant parser, keeping unknown tokens and dropping junk', () => {
    const parsed = parseThemeFile({
      format: THEME_FILE_FORMAT,
      formatVersion: 1,
      name: 'x',
      base: 'oscine',
      overrides: { 'token.from.the.future': 'rgb(1 2 3)', 'font.body': 42 }
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      // A token this build does not define is kept; a value that could not be a
      // token value (a number) is dropped — the same two rules parseOverrides has.
      expect(parsed.themeFile.overrides['token.from.the.future']).toBe('rgb(1 2 3)')
      expect('font.body' in parsed.themeFile.overrides).toBe(false)
    }
  })

  it('tolerates a missing overrides map as no overrides', () => {
    const parsed = parseThemeFile({
      format: THEME_FILE_FORMAT,
      formatVersion: 1,
      name: 'x',
      base: 'oscine'
    })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.themeFile.overrides).toEqual({})
  })
})

describe('theme keys are out of the settings profile', () => {
  it('marks every theme.* descriptor non-portable', () => {
    const themeKeys = SETTINGS_REGISTRY.filter((descriptor) => descriptor.category === 'theme')
    expect(themeKeys.length).toBeGreaterThan(0)
    for (const descriptor of themeKeys) {
      expect(descriptor.portable, `${descriptor.key} should be non-portable`).toBe(false)
    }
  })
})

// A place to lean on the type without a runtime assertion.
const _typed: ThemeFile = buildThemeFile({
  name: 'x',
  base: 'oscine',
  mode: 'system',
  overrides: {}
})
void _typed
