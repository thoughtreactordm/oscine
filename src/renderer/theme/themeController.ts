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
  type RampSpec,
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
  /**
   * The accent read from the current cover, or null when reactive colour is off
   * and whenever nothing is playing.
   *
   * The one input here that is **not** persisted, and must not become so. It is
   * derived from what happens to be playing, so writing it into
   * `theme.overrides` would let one album quietly overwrite a theme the operator
   * authored, and would put that album's colour in the W8-13 export bundle as
   * though it were a choice. It lives here, beside the two other things the app
   * observes rather than the operator states.
   */
  readonly reactiveSeed: string | null
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
  /**
   * The reactive seed actually driving the primary ramp, which is null both when
   * there is none and when the operator's own `color.primary` override is
   * shadowing it. Reported so the settings row can say which of those it is.
   */
  readonly reactiveSeed: string | null
}

export const DEFAULT_INPUTS: ThemeInputs = {
  mode: 'system',
  themeId: DEFAULT_THEME_ID,
  overrides: {},
  systemDark: false,
  systemReducedMotion: false,
  reactiveSeed: null
}

/** The ramp role reactive colour drives, and the only one it may touch. */
const PRIMARY_RAMP_ID = 'color.primary'

/**
 * Layer the cover's accent *under* the operator's overrides.
 *
 * An explicit `color.primary` override wins outright, and that ordering is the
 * whole contract: someone who has pasted a brand colour into the token editor
 * has stated a preference, and artwork is an observation. Merging the two would
 * produce a primary neither of them asked for.
 *
 * Everything else about the theme is untouched — surfaces, text and borders keep
 * coming from the selected theme, so the contrast pairs the theme already
 * satisfies stay satisfied whatever is playing.
 */
function withReactiveSeed(overrides: ThemeOverrides, seed: string | null): ThemeOverrides {
  if (seed === null || overrides[PRIMARY_RAMP_ID] !== undefined) return overrides
  const spec: RampSpec = { mode: 'seed', seed }
  return { ...overrides, [PRIMARY_RAMP_ID]: spec }
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
  const overrides = withReactiveSeed(inputs.overrides, inputs.reactiveSeed)

  return {
    resolved: resolveTheme({
      theme,
      mode,
      overrides,
      reducedMotion: inputs.systemReducedMotion
    }),
    mode,
    themeId: theme.id,
    themeMissing: selected === undefined,
    reactiveSeed: overrides === inputs.overrides ? null : inputs.reactiveSeed
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
