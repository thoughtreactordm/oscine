/**
 * What the theme *is*, given what the operator chose and what the system says.
 *
 * Deliberately free of the DOM: it takes its inputs as plain values and hands
 * its output to a sink. `tests/` compiles under `tsconfig.node.json`, which has
 * no DOM lib, so a renderer module that wants unit tests has to stay clean —
 * the same rule `trackWindow.ts` and `playback/` already follow. Everything
 * that actually touches `document` lives in `applyTheme.ts`, which is thin
 * enough to verify in the live run instead.
 */

import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  findTheme,
  resolveTheme,
  type ResolvedTheme,
  type ThemeMode,
  type ThemeOverrides
} from '@shared/theme'

/** What `theme.mode` holds. `system` is a preference, not a resolved value. */
export type ThemeModePreference = ThemeMode | 'system'

export interface ThemeInputs {
  readonly mode: ThemeModePreference
  readonly themeId: string
  readonly overrides: ThemeOverrides
  /** What the OS reports right now. */
  readonly systemDark: boolean
  readonly systemReducedMotion: boolean
}

export interface ThemeState {
  readonly resolved: ResolvedTheme
  /** The variant actually showing, after `system` has been answered. */
  readonly mode: ThemeMode
  readonly themeId: string
  /**
   * True when the selected theme id names nothing we ship.
   *
   * The default is shown, but the id is *not* rewritten — a theme that stops
   * existing because the operator downgraded should come back when they
   * upgrade again, and silently rewriting the setting is how that becomes
   * impossible. Same instinct as the unknown-key rule.
   */
  readonly themeMissing: boolean
}

export const DEFAULT_INPUTS: ThemeInputs = {
  mode: 'system',
  themeId: DEFAULT_THEME_ID,
  overrides: {},
  systemDark: false,
  systemReducedMotion: false
}

/** Answer `system` from what the OS said. */
export function resolveMode(mode: ThemeModePreference, systemDark: boolean): ThemeMode {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

export function computeTheme(inputs: ThemeInputs): ThemeState {
  const mode = resolveMode(inputs.mode, inputs.systemDark)
  const selected = findTheme(inputs.themeId)
  const theme = selected ?? findTheme(DEFAULT_THEME_ID) ?? BUILT_IN_THEMES[0]!

  return {
    resolved: resolveTheme({
      theme,
      mode,
      overrides: inputs.overrides,
      reducedMotion: inputs.systemReducedMotion
    }),
    mode,
    themeId: theme.id,
    themeMissing: selected === undefined
  }
}

/**
 * The colour a window should paint before the renderer has drawn anything.
 *
 * Taken from the resolved surface rather than from a constant, which is the
 * point: `backgroundColor: '#0a0a0a'` in the main process claims to match "the
 * dark surface token" and does not, because until now no dark surface token
 * existed. Reading it from the same place the app reads it is the only way that
 * comment can stay true across three themes and two variants.
 */
export function windowBackground(state: ThemeState): string | null {
  return state.resolved.tokens.get('surface.base') ?? null
}
