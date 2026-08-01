import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from '@shared/theme'
import {
  computeTheme,
  DEFAULT_INPUTS,
  resolveMode,
  windowBackground,
  type ThemeInputs
} from '../../src/renderer/theme/themeController'

function inputs(patch: Partial<ThemeInputs> = {}): ThemeInputs {
  return { ...DEFAULT_INPUTS, ...patch }
}

describe('resolveMode', () => {
  it('answers system from what the OS reported', () => {
    expect(resolveMode('system', true)).toBe('dark')
    expect(resolveMode('system', false)).toBe('light')
  })

  it('ignores the OS when a mode is pinned', () => {
    expect(resolveMode('light', true)).toBe('light')
    expect(resolveMode('dark', false)).toBe('dark')
  })
})

describe('computeTheme', () => {
  it('follows the system when the preference is system', () => {
    expect(computeTheme(inputs({ systemDark: true })).mode).toBe('dark')
    expect(computeTheme(inputs({ systemDark: false })).mode).toBe('light')
  })

  it('produces different surfaces for the two variants', () => {
    const light = computeTheme(inputs({ mode: 'light' }))
    const dark = computeTheme(inputs({ mode: 'dark' }))
    expect(light.resolved.tokens.get('surface.base')).not.toBe(
      dark.resolved.tokens.get('surface.base')
    )
  })

  it('renders every built-in by id', () => {
    for (const theme of BUILT_IN_THEMES) {
      const state = computeTheme(inputs({ themeId: theme.id }))
      expect(state.themeId).toBe(theme.id)
      expect(state.themeMissing).toBe(false)
      expect(state.resolved.cssVars.size).toBeGreaterThan(50)
    }
  })

  it('falls back for an unknown theme without rewriting the choice', () => {
    // A theme that stops existing because the operator downgraded should come
    // back when they upgrade. Silently rewriting the setting makes that
    // impossible, so the state reports the substitution instead.
    const state = computeTheme(inputs({ themeId: 'a-theme-from-a-later-build' }))
    expect(state.themeMissing).toBe(true)
    expect(state.themeId).toBe(DEFAULT_THEME_ID)
    expect(state.resolved.cssVars.size).toBeGreaterThan(50)
  })

  it('clamps motion when the system asks, whatever the operator set', () => {
    const state = computeTheme(
      inputs({ systemReducedMotion: true, overrides: { 'motion.duration': '900ms' } })
    )
    expect(state.resolved.tokens.get('motion.duration')).toBe('0ms')
  })

  it('carries overrides into the resolved custom properties', () => {
    const state = computeTheme(inputs({ overrides: { 'shape.radius': '0px' } }))
    expect(state.resolved.cssVars.get('--fermata-shape-radius')).toBe('0px')
  })
})

describe('windowBackground', () => {
  it('reads the surface the theme actually resolved', () => {
    // `backgroundColor: '#0a0a0a'` in the main process claimed to match "the
    // dark surface token" while no such token existed. This is what makes the
    // claim checkable.
    for (const theme of BUILT_IN_THEMES) {
      const dark = computeTheme(inputs({ themeId: theme.id, mode: 'dark' }))
      const light = computeTheme(inputs({ themeId: theme.id, mode: 'light' }))
      expect(windowBackground(dark)).toBe(dark.resolved.tokens.get('surface.base'))
      expect(windowBackground(dark)).not.toBe(windowBackground(light))
    }
  })
})
