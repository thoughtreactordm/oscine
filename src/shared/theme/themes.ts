/**
 * The built-in themes, and the mapping that turns two ramps into a full set of
 * surfaces, text weights and borders.
 *
 * A theme is a light variant and a dark variant, not one or the other. `theme.
 * name` picks the theme and `theme.mode` picks the variant, so following the
 * system swaps variants inside the theme the operator chose rather than
 * throwing their choice away every sunset.
 *
 * The semantic mapping is shared. Every theme derives its surfaces and text
 * weights from its own neutral ramp by the same rules, which is what makes a
 * new theme two ramps rather than thirty colours — and it is why a theme that
 * wants something specific declares `values` to override just that one token
 * rather than restating the other twenty-nine.
 */

import type { RampSpec } from './ramp'
import type { ColorRoleId } from './tokens'

/** A semantic colour is a step of a ramp, or a literal when it is neither. */
export type SemanticSource = { readonly role: ColorRoleId; readonly step: string } | string

const WHITE = 'oklch(100% 0 0)'

const step = (role: ColorRoleId, s: string): SemanticSource => ({ role, step: s })

/**
 * Light. Mirrors what Nuxt UI generates today, so switching a fresh install to
 * the built-in Light theme is a no-op rather than a redesign — the point of
 * this card is that the mechanism works, not that the app looks different.
 */
const LIGHT_MAPPING: Readonly<Record<string, SemanticSource>> = {
  'surface.base': WHITE,
  'surface.muted': step('neutral', '50'),
  'surface.elevated': step('neutral', '100'),
  'surface.accented': step('neutral', '200'),
  'surface.inverted': step('neutral', '900'),

  /*
   * Shifted one step darker than Nuxt UI's ladder, which starts at 400 — and
   * 400 is 2.55:1 against white, below even the 3:1 asked of large text.
   *
   * The whole ladder moves rather than just its top, because only 500 and
   * darker carry text legibly on a white surface, and five text weights over
   * six usable steps have to stay distinct. Collapsing two of them onto the
   * same step would silently delete a distinction components rely on.
   */
  'text.dimmed': step('neutral', '500'),
  'text.muted': step('neutral', '600'),
  'text.toned': step('neutral', '700'),
  'text.base': step('neutral', '800'),
  'text.highlighted': step('neutral', '900'),
  'text.inverted': WHITE,

  'border.muted': step('neutral', '200'),
  'border.base': step('neutral', '300'),
  /*
   * A step darker than Nuxt UI's default, which lands at 1.5:1 against white —
   * well under the 3:1 that WCAG 1.4.11 asks of a control boundary. This is the
   * variable the scrollbar thumb and every input outline use, so it is a real
   * boundary rather than decoration.
   */
  'border.accented': step('neutral', '500'),
  'border.inverted': step('neutral', '900'),

  /*
   * 700, not the 500 Nuxt UI would use.
   *
   * The warm roles are what force it. Amber at 500 is about 2:1 against white;
   * at 600 it reaches 3.19 on the window but only 2.84 on a raised panel, which
   * fails the same pair on half the surfaces in the app — the kind of
   * almost-passing that a checker exists to catch. 700 clears 4.4 against both
   * surfaces for every role, which also makes it safe where the accent is used
   * as text rather than as a fill.
   */
  'accent.primary': step('primary', '700'),
  'accent.secondary': step('secondary', '700'),
  'accent.success': step('success', '700'),
  'accent.info': step('info', '700'),
  'accent.warning': step('warning', '700'),
  'accent.error': step('error', '700')
}

const DARK_MAPPING: Readonly<Record<string, SemanticSource>> = {
  'surface.base': step('neutral', '900'),
  'surface.muted': step('neutral', '800'),
  'surface.elevated': step('neutral', '800'),
  'surface.accented': step('neutral', '700'),
  'surface.inverted': WHITE,

  'text.dimmed': step('neutral', '500'),
  'text.muted': step('neutral', '400'),
  'text.toned': step('neutral', '300'),
  'text.base': step('neutral', '200'),
  'text.highlighted': WHITE,
  'text.inverted': step('neutral', '900'),

  'border.muted': step('neutral', '700'),
  'border.base': step('neutral', '700'),
  'border.accented': step('neutral', '500'),
  'border.inverted': WHITE,

  /* 400 on a dark surface, for the mirror-image reason. */
  'accent.primary': step('primary', '400'),
  'accent.secondary': step('secondary', '400'),
  'accent.success': step('success', '400'),
  'accent.info': step('info', '400'),
  'accent.warning': step('warning', '400'),
  'accent.error': step('error', '400')
}

export const SEMANTIC_MAPPING: Readonly<
  Record<ThemeMode, Readonly<Record<string, SemanticSource>>>
> = {
  light: LIGHT_MAPPING,
  dark: DARK_MAPPING
}

/** The resolved variant, after `system` has been answered. */
export type ThemeMode = 'light' | 'dark'

/**
 * Shape, type and motion defaults.
 *
 * Shared by every built-in because they are not what distinguishes a theme —
 * an operator who wants square corners wants them in every theme, and that is
 * an override, not a reason to fork a palette. A theme that genuinely needs
 * different geometry still declares it in `values`.
 *
 * `shape.radius` is 0.25rem to match Nuxt UI's own `--ui-radius`, so the
 * built-in themes change nothing that was not already broken.
 */
export const STRUCTURAL_DEFAULTS: Readonly<Record<string, string>> = {
  'shape.radius': '0.25rem',

  'type.baseSize': '1rem',
  'type.heading.family':
    'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, sans-serif',
  'type.heading.weight': '600',
  'type.heading.style': 'normal',
  'type.list.family':
    'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, sans-serif',
  'type.list.weight': '400',
  'type.list.style': 'normal',
  'type.body.family':
    'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, sans-serif',
  'type.body.weight': '400',
  'type.body.style': 'normal',

  'motion.duration': '150ms',
  'motion.easing': 'cubic-bezier(0.4, 0, 0.2, 1)',

  /*
   * Light needs markedly less bleed than dark: the same opacity that reads as a
   * glow over a dark surface reads as a stain over a pale one. That difference
   * is per-variant, so it lives in the variant's `values` rather than here.
   */
  'nowPlaying.coverBlur': '40px',
  'nowPlaying.coverDrift': '42s',

  /* Fixed across every theme — they sit over arbitrary cover art. */
  'nowPlaying.scrim': 'oklch(0% 0 0 / 0.62)',
  'nowPlaying.onScrim': WHITE
}

export interface ThemeVariant {
  readonly ramps: Readonly<Record<ColorRoleId, RampSpec>>
  /**
   * Applied over the derived semantic mapping and the structural defaults.
   *
   * Takes the same union the mapping does, so a theme can pin a token to a
   * literal *or* move it to a different step of its own ramp. Restricting this
   * to literals would force a theme that only wants `text.base` one step darker
   * to hardcode the colour, which stops being that theme's colour the moment
   * its neutral ramp changes.
   */
  readonly values?: Readonly<Record<string, SemanticSource>>
}

export interface BuiltInTheme {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly light: ThemeVariant
  readonly dark: ThemeVariant
}

const palette = (name: string): RampSpec => ({ mode: 'palette', palette: name })
const seed = (value: string): RampSpec => ({ mode: 'seed', seed: value })

/**
 * The status ramps. Shared by the themes that have no reason to restate them —
 * an error being red is not a stylistic position, and a theme that recoloured
 * it would be trading legibility for coherence.
 */
const STATUS_RAMPS = {
  success: palette('green'),
  info: palette('blue'),
  warning: palette('amber'),
  error: palette('red')
} as const

const FERMATA: BuiltInTheme = {
  id: 'fermata',
  label: 'Fermata',
  description: 'Warm amber on a taupe grey. What the app has always looked like.',
  light: {
    ramps: {
      primary: palette('amber'),
      secondary: palette('orange'),
      neutral: palette('taupe'),
      ...STATUS_RAMPS
    },
    values: { 'nowPlaying.coverBleed': '0.18' }
  },
  dark: {
    ramps: {
      primary: palette('amber'),
      secondary: palette('orange'),
      neutral: palette('taupe'),
      ...STATUS_RAMPS
    },
    values: { 'nowPlaying.coverBleed': '0.28' }
  }
}

/**
 * The off-palette one, and the reason it ships in this pass.
 *
 * Its primary sits at hue 197 — between Tailwind's `teal` at 183 and `cyan` at
 * 221, in a gap no shipped ramp occupies — and its neutral is a faintly cool
 * grey rather than a pure or warm one. Neither ramp can be produced by naming a
 * Tailwind palette, so a theme swap that lands correctly here is evidence that
 * T2 bought something real: the token layer is not an alias for Nuxt UI's
 * generated colours, it replaces them.
 */
const NOCTURNE: BuiltInTheme = {
  id: 'nocturne',
  label: 'Nocturne',
  description: 'Cold verdigris on a blue-shifted grey. Off-palette by construction.',
  light: {
    ramps: {
      primary: seed('oklch(64% 0.115 197)'),
      secondary: seed('oklch(62% 0.13 268)'),
      neutral: seed('oklch(62% 0.014 235)'),
      ...STATUS_RAMPS
    },
    values: { 'nowPlaying.coverBleed': '0.16' }
  },
  dark: {
    ramps: {
      primary: seed('oklch(70% 0.115 197)'),
      secondary: seed('oklch(68% 0.13 268)'),
      neutral: seed('oklch(62% 0.014 235)'),
      ...STATUS_RAMPS
    },
    values: { 'nowPlaying.coverBleed': '0.3' }
  }
}

/**
 * A high-contrast theme.
 *
 * Not an accessibility mode — the app has no such setting and pretending one
 * token set is "the accessible one" would be worse than not shipping it. It is
 * a theme for bright rooms and cheap panels, and it doubles as the case that
 * keeps the contrast checker honest: if this theme ever reports a failure, the
 * checker and the mapping disagree and one of them is wrong.
 */
const SLATE: BuiltInTheme = {
  id: 'slate',
  label: 'Slate',
  description: 'Neutral blue-grey, pushed for contrast. For bright rooms.',
  light: {
    ramps: {
      primary: palette('blue'),
      secondary: palette('indigo'),
      neutral: palette('slate'),
      ...STATUS_RAMPS
    },
    values: {
      // Titles pushed to the darkest step the ramp has, which is the whole
      // point of the theme. Expressed as a step so it stays this theme's grey
      // rather than becoming a fixed colour the moment its neutral ramp
      // changes — and 950 because the shared ladder already occupies 500
      // through 900, leaving nowhere else to go without colliding.
      'text.highlighted': step('neutral', '950'),
      'nowPlaying.coverBleed': '0.12'
    }
  },
  dark: {
    ramps: {
      primary: palette('sky'),
      secondary: palette('indigo'),
      neutral: palette('slate'),
      ...STATUS_RAMPS
    },
    values: { 'nowPlaying.coverBleed': '0.24' }
  }
}

export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [FERMATA, NOCTURNE, SLATE]

export const DEFAULT_THEME_ID = FERMATA.id

export function findTheme(id: string): BuiltInTheme | undefined {
  return BUILT_IN_THEMES.find((theme) => theme.id === id)
}
