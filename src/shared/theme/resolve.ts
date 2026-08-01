/**
 * Composing a theme, an operator's overrides and the system's motion
 * preference into one flat map of token id to CSS value.
 *
 * Pure, and deliberately so: this is the function the renderer calls on every
 * keystroke in the token editor, and it is also the function the tests assert
 * "swapping a theme touches zero component code" against. Nothing here reaches
 * for the DOM.
 */

import { resolveRamp, RAMP_STEPS, type RampSpec, type RampSteps } from './ramp'
import {
  COLOR_ROLES,
  findToken,
  rampTokenId,
  type ColorRoleId,
  type ResolvedTokens
} from './tokens'
import {
  SEMANTIC_MAPPING,
  STRUCTURAL_DEFAULTS,
  type BuiltInTheme,
  type SemanticSource,
  type ThemeMode,
  type ThemeVariant
} from './themes'

/**
 * The operator's overrides. A ramp role is overridden with a spec; everything
 * else with a literal CSS value.
 */
export type ThemeOverrides = Readonly<Record<string, string | RampSpec>>

export interface ResolvedTheme {
  /** Token id to CSS value, colour roles already expanded to eleven steps. */
  readonly tokens: ResolvedTokens
  /** CSS custom property to value — what the bridge writes. */
  readonly cssVars: ReadonlyMap<string, string>
  /**
   * Overrides that named a real token but could not be resolved — an
   * unparseable colour, a palette name that is not Tailwind's. Reported so the
   * editor can mark the row rather than showing a value nobody chose.
   */
  readonly unresolved: readonly string[]
  /**
   * Overrides naming a token the catalog does not define. **Kept, not
   * dropped.** Themes gain and lose tokens, and an operator who switches theme,
   * finds a token gone and switches back must find their override intact. They
   * are inert until a theme defines the name again.
   */
  readonly unknown: readonly string[]
}

export interface ResolveOptions {
  readonly theme: BuiltInTheme
  readonly mode: ThemeMode
  readonly overrides?: ThemeOverrides
  /**
   * The system's `prefers-reduced-motion`. T12: when this is true the motion
   * tokens are clamped *after* overrides, so no theme and no override can
   * defeat it.
   */
  readonly reducedMotion?: boolean
}

function isRampSpec(value: unknown): value is RampSpec {
  return typeof value === 'object' && value !== null && 'mode' in value
}

/** Resolve a `SemanticSource` against the already-expanded ramp steps. */
function readSource(source: SemanticSource, tokens: Map<string, string>): string | null {
  if (typeof source === 'string') return source
  return tokens.get(rampTokenId(source.role, source.step)) ?? null
}

export function resolveTheme(options: ResolveOptions): ResolvedTheme {
  const { theme, mode, overrides = {}, reducedMotion = false } = options
  const variant: ThemeVariant = theme[mode]

  const tokens = new Map<string, string>()
  const unresolved: string[] = []
  const unknown: string[] = []

  /*
   * 1. Ramps first — everything else may reference a step of one. An override
   *    replaces the theme's spec outright rather than merging with it: a ramp
   *    half from the theme and half from the operator is neither, and the three
   *    authoring modes are not mergeable anyway.
   */
  for (const role of COLOR_ROLES) {
    const id = `color.${role.id}`
    const override = overrides[id]
    const spec: RampSpec | undefined = isRampSpec(override)
      ? override
      : variant.ramps[role.id as ColorRoleId]

    let steps: RampSteps | null = spec ? resolveRamp(spec) : null
    if (!steps && isRampSpec(override)) {
      // The override is what failed. Fall back to the theme's own ramp so the
      // app stays usable, and say which token is showing something unchosen.
      unresolved.push(id)
      const themeSpec = variant.ramps[role.id as ColorRoleId]
      steps = themeSpec ? resolveRamp(themeSpec) : null
    }
    if (!steps) continue

    for (const step of RAMP_STEPS) {
      tokens.set(rampTokenId(role.id, step), steps[step])
    }
  }

  // 2. Structural defaults, then 3. the mode's semantic mapping, then 4. the
  //    variant's own overrides on top of both.
  for (const [id, value] of Object.entries(STRUCTURAL_DEFAULTS)) {
    tokens.set(id, value)
  }
  for (const [id, source] of Object.entries(SEMANTIC_MAPPING[mode])) {
    const value = readSource(source, tokens)
    if (value !== null) tokens.set(id, value)
  }
  for (const [id, source] of Object.entries(variant.values ?? {})) {
    const value = readSource(source, tokens)
    if (value !== null) tokens.set(id, value)
  }

  // 5. The operator, last — except for the motion clamp below.
  for (const [id, value] of Object.entries(overrides)) {
    if (isRampSpec(value)) continue // handled in step 1
    if (!findToken(id)) {
      unknown.push(id)
      continue
    }
    tokens.set(id, value)
  }

  /*
   * 6. T12. After the operator, because the point is that it cannot be
   *    overridden — an accessibility preference the OS states is not something
   *    a theme gets a vote on. Both are set to zero rather than merely
   *    shortened: a 20ms drift is still drift.
   */
  if (reducedMotion) {
    tokens.set('motion.duration', '0ms')
    tokens.set('nowPlaying.coverDrift', '0s')
  }

  return {
    tokens,
    cssVars: toCssVars(tokens),
    unresolved,
    unknown
  }
}

/**
 * Map token ids onto the custom properties the bridge writes.
 *
 * Ramp steps take their role's variable with the step appended, which is why
 * the catalog only declares the base. A token with no descriptor is skipped —
 * that is the unknown-override case, and it has no variable to land on.
 */
function toCssVars(tokens: ReadonlyMap<string, string>): Map<string, string> {
  const vars = new Map<string, string>()

  for (const [id, value] of tokens) {
    const dashIndex = id.lastIndexOf('-')
    if (id.startsWith('color.') && dashIndex > 0) {
      const base = findToken(id.slice(0, dashIndex))
      if (base) {
        vars.set(`${base.cssVar}-${id.slice(dashIndex + 1)}`, value)
        continue
      }
    }

    const token = findToken(id)
    if (token) vars.set(token.cssVar, value)
  }

  return vars
}
