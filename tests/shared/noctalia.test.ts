import { describe, expect, it } from 'vitest'
import {
  NOCTALIA_ROLES,
  noctaliaTemplate,
  parseNoctaliaPalette,
  withNoctaliaColors,
  type NoctaliaColors
} from '../../src/shared/theme'

function colors(fill: string): NoctaliaColors {
  return Object.fromEntries(NOCTALIA_ROLES.map((role) => [role, fill])) as NoctaliaColors
}

const palette = { version: 1, light: colors('#eeeeee'), dark: colors('#111111') } as const

describe('parseNoctaliaPalette', () => {
  it('accepts a complete palette', () => {
    expect(parseNoctaliaPalette(palette)).toEqual(palette)
  })

  it('drops anything beyond the exported roles', () => {
    const parsed = parseNoctaliaPalette({
      ...palette,
      dark: { ...palette.dark, primary: '#ff0000', css: 'body{}' }
    })
    expect(Object.keys(parsed.dark).sort()).toEqual([...NOCTALIA_ROLES].sort())
  })

  it('rejects an unknown version, a missing variant and a non-hex colour', () => {
    expect(() => parseNoctaliaPalette({ ...palette, version: 2 })).toThrow('Unsupported')
    expect(() => parseNoctaliaPalette({ version: 1, light: palette.light })).toThrow('dark')
    expect(() =>
      parseNoctaliaPalette({ ...palette, light: { ...palette.light, surface: 'red' } })
    ).toThrow('light.surface')
  })
})

describe('noctaliaTemplate', () => {
  it('exports every role in both variants, and no primary', () => {
    const template = JSON.parse(noctaliaTemplate()) as Record<string, Record<string, string>>
    expect(template.version).toBe(1)
    for (const mode of ['light', 'dark'] as const) {
      for (const role of NOCTALIA_ROLES) {
        expect(template[mode]![role]).toBe(`{{colors.${role}.${mode}.hex}}`)
      }
    }
    expect(noctaliaTemplate()).not.toContain('primary')
  })
})

describe('withNoctaliaColors', () => {
  it('is the identity without a palette', () => {
    const overrides = { 'surface.base': '#123456' }
    expect(withNoctaliaColors(overrides, null, 'dark')).toBe(overrides)
  })

  it('takes the variant for the mode', () => {
    expect(withNoctaliaColors({}, palette, 'dark')['surface.base']).toBe('#111111')
    expect(withNoctaliaColors({}, palette, 'light')['surface.base']).toBe('#eeeeee')
  })

  it('feeds info from tertiary', () => {
    const custom = { ...palette, dark: { ...palette.dark, tertiary: '#abcdef' } }
    const merged = withNoctaliaColors({}, custom, 'dark')
    expect(merged['accent.info']).toBe('#abcdef')
    expect(merged['color.info']).toEqual({ mode: 'seed', seed: '#abcdef' })
  })

  it('never touches primary, and keeps what it does not replace', () => {
    const own = { mode: 'seed', seed: '#ff0000' } as const
    const merged = withNoctaliaColors(
      { 'color.primary': own, 'font.body': 'Inter', 'surface.base': '#000000' },
      palette,
      'dark'
    )
    expect(merged['color.primary']).toEqual(own)
    expect(merged['accent.primary']).toBeUndefined()
    expect(merged['font.body']).toBe('Inter')
    expect(merged['surface.base']).toBe('#111111')
  })
})
