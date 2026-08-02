import { describe, expect, it } from 'vitest'
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, rampFromSeed } from '@shared/theme'
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

describe('computeTheme with a reactive seed', () => {
  const seed = 'oklch(0.68 0.18 264)'

  it('drives the primary ramp from the seed', () => {
    const plain = computeTheme(inputs())
    const reactive = computeTheme(inputs({ reactiveSeed: seed }))

    expect(reactive.resolved.cssVars.get('--fermata-color-primary-500')).toBe(
      rampFromSeed(seed)?.['500']
    )
    expect(reactive.resolved.cssVars.get('--fermata-color-primary-500')).not.toBe(
      plain.resolved.cssVars.get('--fermata-color-primary-500')
    )
    expect(reactive.reactiveSeed).toBe(seed)
  })

  it('is the sanctioned override path and nothing beside it', () => {
    // Byte-identical to writing the same seed into the token editor. That is
    // the whole of what reactive colour does — no second mechanism, no token it
    // can reach that an operator could not.
    const reactive = computeTheme(inputs({ reactiveSeed: seed }))
    const manual = computeTheme(inputs({ overrides: { 'color.primary': { mode: 'seed', seed } } }))
    expect([...reactive.resolved.cssVars]).toEqual([...manual.resolved.cssVars])
  })

  it('leaves every surface, text and border token where the theme put it', () => {
    // The scope guarantee, and the reason this was worth keeping to one role:
    // the contrast pairs the theme already satisfies are pairs of these, so
    // whatever is playing they stay satisfied. `accent.primary` is expected to
    // move — it is the accent, which is the point.
    const plain = computeTheme(inputs())
    const reactive = computeTheme(inputs({ reactiveSeed: seed }))

    for (const [id, value] of plain.resolved.tokens) {
      if (id.startsWith('color.primary') || id === 'accent.primary') continue
      expect(reactive.resolved.tokens.get(id)).toBe(value)
    }
  })

  it('yields to an accent the operator set themselves', () => {
    // An override is a stated preference; artwork is an observation. Merging
    // them would produce a primary neither of them asked for.
    const chosen = computeTheme(
      inputs({
        reactiveSeed: seed,
        overrides: { 'color.primary': { mode: 'seed', seed: '#ff0000' } }
      })
    )
    const withoutArt = computeTheme(
      inputs({ overrides: { 'color.primary': { mode: 'seed', seed: '#ff0000' } } })
    )

    expect(chosen.resolved.cssVars.get('--fermata-color-primary-500')).toBe(
      withoutArt.resolved.cssVars.get('--fermata-color-primary-500')
    )
    expect(chosen.reactiveSeed).toBeNull()
  })

  it('is exactly the plain theme when there is no seed', () => {
    const plain = computeTheme(inputs())
    expect(plain.reactiveSeed).toBeNull()
    expect([...plain.resolved.cssVars]).toEqual([...computeTheme(inputs()).resolved.cssVars])
  })

  it('leaves the theme own primary when the seed will not parse', () => {
    const plain = computeTheme(inputs())
    const broken = computeTheme(inputs({ reactiveSeed: 'not a colour' }))
    expect(broken.resolved.cssVars.get('--fermata-color-primary-500')).toBe(
      plain.resolved.cssVars.get('--fermata-color-primary-500')
    )
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
