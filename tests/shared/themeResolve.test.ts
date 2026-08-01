import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_THEMES,
  CONTRAST_PAIRS,
  DEFAULT_THEME_ID,
  HIGH_CONTRAST_THEME_ID,
  PUBLIC_TOKENS,
  STRICT_CONTRAST_PAIRS,
  RAMP_STEPS,
  TAILWIND_PALETTES,
  TOKENS,
  findContrastFailures,
  findTheme,
  parseColor,
  parseOverrides,
  rampTokenId,
  resolveTheme,
  withOverride,
  withoutOverride,
  type RampSteps,
  type ThemeMode
} from '@shared/theme'

const MODES: readonly ThemeMode[] = ['light', 'dark']

function resolve(themeId: string, mode: ThemeMode, overrides = {}, reducedMotion = false) {
  const theme = findTheme(themeId)
  expect(theme, `no theme ${themeId}`).toBeDefined()
  return resolveTheme({ theme: theme!, mode, overrides, reducedMotion })
}

describe('the catalog', () => {
  it('has unique ids and unique custom properties', () => {
    const ids = TOKENS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    const vars = TOKENS.map((t) => t.cssVar)
    expect(new Set(vars).size).toBe(vars.length)
  })

  it('names every custom property in the --fermata- namespace', () => {
    for (const token of TOKENS) {
      expect(token.cssVar, token.id).toMatch(/^--fermata-/)
    }
  })

  it('keeps the now-playing variables at the names they shipped with', () => {
    // Renaming these would mean editing NowPlaying — the one component edit
    // this card exists to prove is unnecessary.
    const byId = new Map(TOKENS.map((t) => [t.id, t]))
    expect(byId.get('nowPlaying.coverBleed')?.cssVar).toBe('--fermata-cover-bleed')
    expect(byId.get('nowPlaying.coverBlur')?.cssVar).toBe('--fermata-cover-blur')
    expect(byId.get('nowPlaying.coverDrift')?.cssVar).toBe('--fermata-cover-drift')
  })

  it('keeps the scrim pair internal, so no theme can tint text over cover art', () => {
    const byId = new Map(TOKENS.map((t) => [t.id, t]))
    expect(byId.get('nowPlaying.scrim')?.public).toBe(false)
    expect(byId.get('nowPlaying.onScrim')?.public).toBe(false)
    expect(PUBLIC_TOKENS.map((t) => t.id)).not.toContain('nowPlaying.scrim')
  })
})

describe('resolveTheme', () => {
  it('resolves every public token for every built-in in both modes', () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of MODES) {
        const { tokens } = resolve(theme.id, mode)
        for (const token of PUBLIC_TOKENS) {
          // A ramp resolves to its eleven steps rather than to its own id.
          if (token.kind === 'ramp') {
            for (const step of RAMP_STEPS) {
              const id = rampTokenId(token.id.slice('color.'.length), step)
              expect(tokens.get(id), `${theme.id}/${mode} ${id}`).toBeDefined()
            }
            continue
          }
          expect(tokens.get(token.id), `${theme.id}/${mode} ${token.id}`).toBeDefined()
        }
      }
    }
  })

  it('emits a custom property for every resolved token', () => {
    const { tokens, cssVars } = resolve(DEFAULT_THEME_ID, 'dark')
    expect(cssVars.size).toBe(tokens.size)
    expect(cssVars.get('--fermata-surface-base')).toBeDefined()
    expect(cssVars.get('--fermata-color-primary-500')).toBeDefined()
    expect(cssVars.get('--fermata-cover-bleed')).toBe('0.28')
  })

  it('gives light and dark genuinely different surfaces', () => {
    const light = resolve(DEFAULT_THEME_ID, 'light').tokens
    const dark = resolve(DEFAULT_THEME_ID, 'dark').tokens
    expect(light.get('surface.base')).not.toBe(dark.get('surface.base'))
    expect(light.get('text.base')).not.toBe(dark.get('text.base'))
    // The ramps are shared between variants; only the mapping differs.
    expect(light.get('color.primary-500')).toBe(dark.get('color.primary-500'))
  })

  it('lets a variant move a semantic token to a different step of its own ramp', () => {
    const strict = resolve(HIGH_CONTRAST_THEME_ID, 'light').tokens
    expect(strict.get('text.highlighted')).toBe(strict.get('color.neutral-950'))
    // ...where the shared mapping would have put it at 900.
    const fermata = resolve(DEFAULT_THEME_ID, 'light').tokens
    expect(fermata.get('text.highlighted')).toBe(fermata.get('color.neutral-900'))
  })

  it('keeps the five light text weights on five distinct steps', () => {
    // Collapsing two onto the same step would silently delete a distinction
    // components rely on, and it is an easy accident when fixing contrast.
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of MODES) {
        const { tokens } = resolve(theme.id, mode)
        const weights = ['dimmed', 'muted', 'toned', 'base', 'highlighted'].map((w) =>
          tokens.get(`text.${w}`)
        )
        expect(new Set(weights).size, `${theme.id}/${mode}`).toBe(weights.length)
      }
    }
  })

  it('gives each mode its own accent step', () => {
    // `text-primary` resolves to one colour, not a ramp, and the step that
    // reads correctly on a dark surface is around 2:1 on a white one. Every
    // theme must therefore move it between modes.
    for (const theme of BUILT_IN_THEMES) {
      const light = resolve(theme.id, 'light').tokens
      const dark = resolve(theme.id, 'dark').tokens
      expect(light.get('accent.primary'), theme.id).not.toBe(dark.get('accent.primary'))
      expect(light.get('accent.primary')).toBe(light.get('color.primary-700'))
      expect(dark.get('accent.primary')).toBe(dark.get('color.primary-400'))
    }
  })

  it('resolves the accent variables the app references but never defined', () => {
    // `--color-primary: var(--ui-primary)` ships with nothing defining
    // `--ui-primary`, so these tokens are what stop the accent resolving to an
    // undefined custom property.
    const { cssVars } = resolve(DEFAULT_THEME_ID, 'dark')
    for (const role of ['primary', 'secondary', 'success', 'info', 'warning', 'error']) {
      expect(cssVars.get(`--fermata-accent-${role}`), role).toBeDefined()
    }
  })

  it('builds Nocturne from ramps no Tailwind palette can produce', () => {
    // T2's evidence: if this resolved to a shipped palette, the token layer
    // would be an alias for Nuxt UI's generated colours rather than a
    // replacement for them.
    const { tokens } = resolve('nocturne', 'dark')
    const primary = RAMP_STEPS.map((step) => tokens.get(rampTokenId('primary', step)))
    for (const [name, palette] of Object.entries(TAILWIND_PALETTES)) {
      const shipped = RAMP_STEPS.map((step) => (palette as RampSteps)[step])
      expect(primary, `matched ${name}`).not.toEqual(shipped)
    }
    const mid = parseColor(tokens.get(rampTokenId('primary', '500'))!)!
    // Between teal (183) and cyan (221), where no shipped ramp sits.
    expect(mid.h).toBeGreaterThan(190)
    expect(mid.h).toBeLessThan(205)
  })
})

describe('overrides', () => {
  it('layers a scalar override over the theme', () => {
    const { tokens } = resolve(DEFAULT_THEME_ID, 'dark', { 'shape.radius': '0px' })
    expect(tokens.get('shape.radius')).toBe('0px')
  })

  it('replaces a whole ramp and everything derived from it', () => {
    const base = resolve(DEFAULT_THEME_ID, 'dark').tokens
    const { tokens } = resolve(DEFAULT_THEME_ID, 'dark', {
      'color.neutral': { mode: 'palette', palette: 'slate' }
    })
    expect(tokens.get('color.neutral-500')).toBe((TAILWIND_PALETTES.slate as RampSteps)['500'])
    // The surfaces follow, because they are the ramp rather than copies of it.
    expect(tokens.get('surface.base')).not.toBe(base.get('surface.base'))
    expect(tokens.get('surface.base')).toBe(tokens.get('color.neutral-900'))
  })

  it('keeps an override naming a token no theme defines', () => {
    // The unknown-key rule. Themes gain and lose tokens; switching away and
    // back must not destroy the operator's work.
    const { tokens, unknown } = resolve(DEFAULT_THEME_ID, 'dark', {
      'surface.someFutureToken': 'oklch(50% 0 0)'
    })
    expect(unknown).toContain('surface.someFutureToken')
    expect(tokens.has('surface.someFutureToken')).toBe(false)
  })

  it('reports an unresolvable ramp override and falls back to the theme', () => {
    const base = resolve(DEFAULT_THEME_ID, 'dark').tokens
    const { tokens, unresolved } = resolve(DEFAULT_THEME_ID, 'dark', {
      'color.primary': { mode: 'palette', palette: 'burgundy' }
    })
    expect(unresolved).toContain('color.primary')
    expect(tokens.get('color.primary-500')).toBe(base.get('color.primary-500'))
  })

  it('survives a theme switch', () => {
    const overrides = { 'shape.radius': '0px', 'motion.duration': '80ms' }
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of MODES) {
        const { tokens } = resolve(theme.id, mode, overrides)
        expect(tokens.get('shape.radius'), `${theme.id}/${mode}`).toBe('0px')
        expect(tokens.get('motion.duration'), `${theme.id}/${mode}`).toBe('80ms')
      }
    }
  })
})

describe('reduced motion', () => {
  it('clamps motion to zero after the operator, so no override can defeat it', () => {
    const { tokens } = resolve(
      DEFAULT_THEME_ID,
      'dark',
      { 'motion.duration': '900ms', 'nowPlaying.coverDrift': '120s' },
      true
    )
    expect(tokens.get('motion.duration')).toBe('0ms')
    expect(tokens.get('nowPlaying.coverDrift')).toBe('0s')
  })

  it('leaves motion alone when the system has not asked', () => {
    const { tokens } = resolve(DEFAULT_THEME_ID, 'dark', { 'motion.duration': '900ms' }, false)
    expect(tokens.get('motion.duration')).toBe('900ms')
  })
})

describe('parseOverrides', () => {
  it('keeps a valid scalar and a valid ramp spec', () => {
    const parsed = parseOverrides({
      'shape.radius': '0px',
      'color.primary': { mode: 'palette', palette: 'violet' }
    })
    expect(parsed['shape.radius']).toBe('0px')
    expect(parsed['color.primary']).toEqual({ mode: 'palette', palette: 'violet' })
  })

  it('keeps an entry for a token the catalog does not define', () => {
    expect(parseOverrides({ 'not.a.token': 'red' })['not.a.token']).toBe('red')
  })

  it('drops what cannot be a token value', () => {
    const parsed = parseOverrides({
      a: null,
      b: 42,
      c: [],
      d: {},
      e: { mode: 'palette', palette: 'burgundy' },
      f: { mode: 'custom', steps: { '50': 'red' } },
      g: ''
    })
    expect(Object.keys(parsed)).toEqual([])
  })

  it('refuses a value that could escape its declaration', () => {
    const parsed = parseOverrides({
      'shape.radius': '0px; background: red',
      'text.base': 'red } body {',
      'motion.easing': 'linear /* comment'
    })
    expect(Object.keys(parsed)).toEqual([])
  })

  it('resolves a corrupt blob to no overrides rather than throwing', () => {
    expect(parseOverrides(null)).toEqual({})
    expect(parseOverrides('nonsense')).toEqual({})
    expect(parseOverrides([1, 2, 3])).toEqual({})
    expect(parseOverrides(undefined)).toEqual({})
  })
})

describe('editing the override map', () => {
  it('returns the same object when reverting something not overridden', () => {
    // Identity is how the caller avoids spending a debounced write.
    const overrides = { 'shape.radius': '0px' }
    expect(withoutOverride(overrides, 'motion.duration')).toBe(overrides)
    expect(withoutOverride(overrides, 'shape.radius')).not.toBe(overrides)
  })

  it('clears an override when set to null', () => {
    const overrides = withOverride({ 'shape.radius': '0px' }, 'shape.radius', null)
    expect(overrides).toEqual({})
  })
})

/*
 * The acceptance test for the built-ins.
 *
 * T7 warns rather than blocks, which is the right call for an operator's own
 * overrides — but a theme we ship failing its own contrast pairs would be a bug
 * we shipped, not a choice anyone made. If this fails, either a built-in's
 * mapping is wrong or the checker is, and both are worth stopping for.
 */
describe('every built-in theme is legible', () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const mode of MODES) {
      it(`${theme.id} / ${mode} passes every contrast pair`, () => {
        const { tokens } = resolve(theme.id, mode)
        const failures = findContrastFailures(tokens, CONTRAST_PAIRS)
        const detail = failures.map((f) => `${f.pair.where}: ${f.ratio.toFixed(2)} < ${f.required}`)
        expect(detail).toEqual([])
      })
    }
  }

  for (const mode of MODES) {
    it(`high-contrast / ${mode} also passes the pairs the defaults skip`, () => {
      // The defaults deliberately do not meet these two. This theme exists so
      // that "lenient" cannot quietly decay into "broken" — if the checker
      // itself stops working, this run is what notices.
      const { tokens } = resolve(HIGH_CONTRAST_THEME_ID, mode)
      const failures = findContrastFailures(tokens, [...CONTRAST_PAIRS, ...STRICT_CONTRAST_PAIRS])
      expect(failures.map((f) => `${f.pair.where}: ${f.ratio.toFixed(2)} < ${f.required}`)).toEqual(
        []
      )
    })

    it(`the default theme is measurably gentler than high-contrast in ${mode}`, () => {
      // The claim the two themes exist to make: the default is tuned for how
      // the app should look, and this one for legibility winning every
      // argument. If they ever converge, one of them has lost its reason to be.
      const soft = resolve(DEFAULT_THEME_ID, mode).tokens
      const strict = resolve(HIGH_CONTRAST_THEME_ID, mode).tokens
      expect(soft.get('text.base')).not.toBe(soft.get('text.highlighted'))
      expect(strict.get('text.dimmed')).not.toBe(soft.get('text.dimmed'))
    })
  }

  it('actually reports a failure when one is authored', () => {
    // A checker that never fires would pass the suite above for the wrong
    // reason.
    const { tokens } = resolve(DEFAULT_THEME_ID, 'dark', {
      'text.base': 'oklch(25% 0 0)'
    })
    const failures = findContrastFailures(tokens, CONTRAST_PAIRS, new Set(['text.base']))
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]?.blame).toBe('text.base')
  })
})
