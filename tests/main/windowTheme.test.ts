import { describe, expect, it } from 'vitest'
import { resolveWindowBackground, WINDOW_BACKGROUND_KEYS } from '../../src/main/windowTheme'
import {
  THEME_MODE_KEY,
  THEME_NAME_KEY,
  THEME_OVERRIDES_KEY,
  settingDefault
} from '../../src/shared/settings'
import { BUILT_IN_THEMES, findTheme, parseColor, resolveTheme, toHex } from '../../src/shared/theme'

/**
 * The claim `backgroundColor: '#0a0a0a'` used to make and could not keep.
 *
 * The window is painted by the compositor before any stylesheet exists, so this
 * colour cannot come from CSS — but it must agree with what the renderer will
 * draw a moment later, or the flash the literal was there to prevent comes back
 * wearing a different colour.
 */

function reader(stored: Record<string, unknown> = {}) {
  return {
    get<T>(key: string): T {
      return (key in stored ? stored[key] : settingDefault(key)) as T
    }
  }
}

describe('resolveWindowBackground', () => {
  it('answers a hex colour the compositor can use', () => {
    expect(resolveWindowBackground(reader(), true)).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('follows the system when the preference is system', () => {
    const dark = resolveWindowBackground(reader(), true)
    const light = resolveWindowBackground(reader(), false)
    expect(dark).not.toBe(light)
  })

  it('ignores the system when a mode is pinned', () => {
    const pinned = { [THEME_MODE_KEY]: 'dark' }
    expect(resolveWindowBackground(reader(pinned), false)).toBe(
      resolveWindowBackground(reader(pinned), true)
    )
  })

  it('matches the surface the renderer resolves, for every theme and variant', () => {
    // The whole point: one resolver, two consumers, no drift.
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const expected = toHex(
          parseColor(resolveTheme({ theme, mode }).tokens.get('surface.base')!)!
        )
        const actual = resolveWindowBackground(
          reader({ [THEME_NAME_KEY]: theme.id, [THEME_MODE_KEY]: mode }),
          mode === 'dark'
        )
        expect(actual, `${theme.id}/${mode}`).toBe(expected)
      }
    }
  })

  it('follows an override of the surface', () => {
    const overridden = resolveWindowBackground(
      reader({
        [THEME_MODE_KEY]: 'dark',
        [THEME_OVERRIDES_KEY]: { 'surface.base': 'oklch(30% 0.1 300)' }
      }),
      true
    )
    expect(overridden).toBe(toHex(parseColor('oklch(30% 0.1 300)')!))
  })

  it('falls back to the default theme when the chosen one is gone', () => {
    const missing = resolveWindowBackground(
      reader({ [THEME_NAME_KEY]: 'a-theme-from-a-later-build', [THEME_MODE_KEY]: 'dark' }),
      true
    )
    const expected = resolveWindowBackground(reader({ [THEME_MODE_KEY]: 'dark' }), true)
    expect(missing).toBe(expected)
  })

  it('survives a corrupt override blob rather than refusing to paint', () => {
    const colour = resolveWindowBackground(
      reader({ [THEME_OVERRIDES_KEY]: 'not an object at all' }),
      true
    )
    expect(colour).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('is not the old hardcoded colour for any shipped theme', () => {
    // `#0a0a0a` was not a token and never matched one. If it reappears, someone
    // has reintroduced a literal.
    for (const theme of BUILT_IN_THEMES) {
      const colour = resolveWindowBackground(
        reader({ [THEME_NAME_KEY]: theme.id, [THEME_MODE_KEY]: 'dark' }),
        true
      )
      expect(colour, theme.id).not.toBe('#0a0a0a')
    }
  })
})

describe('WINDOW_BACKGROUND_KEYS', () => {
  it('names every key that can move the colour, and nothing else', () => {
    // A key missing here means a settings write that silently leaves the frame
    // behind a resize showing the previous theme until relaunch.
    expect([...WINDOW_BACKGROUND_KEYS].sort()).toEqual(
      [THEME_MODE_KEY, THEME_NAME_KEY, THEME_OVERRIDES_KEY].sort()
    )
    for (const key of WINDOW_BACKGROUND_KEYS) {
      expect(findTheme, key).toBeTypeOf('function')
      expect(() => settingDefault(key)).not.toThrow()
    }
  })
})
