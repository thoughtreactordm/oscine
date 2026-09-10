/**
 * Theme keys — W8-12's three, and the reason they are their own category.
 *
 * The token editor exposes ~30 named tokens. Buried in Interface, alongside
 * date formats and confirmation prompts, it would be unfindable; a surface that
 * large earns a rail entry. That is also why `theme.mode` moved out of
 * `interface.theme`: the one setting most obviously about theming should not be
 * the one setting not in the Theme section. Migration `008-theme-keys` carries
 * the stored row across.
 *
 * All four are durable but **not portable**. A theme is not a configuration:
 * communities trade named, self-contained themes, not a colleague's whole
 * settings table with a palette buried in it. So these leave a settings profile
 * (W8-13's export bundle holds them back on `portable: false`) and travel as
 * their own `.osctheme` file instead — `../theme/themeFile.ts`, which carries
 * the overrides, the base theme and the mode under a name a picker can list.
 *
 * `theme.reactive` is the fourth and the odd one: a durable key whose *effect*
 * is deliberately not durable, and which no `.osctheme` carries — its accent is
 * this machine's now-playing colour, not part of the authored look. See its
 * note below.
 */

import {
  DEFAULT_THEME_ID,
  LEGACY_DEFAULT_THEME_ID,
  parseOverrides,
  type ThemeOverrides
} from '../theme'
import {
  acceptValue,
  booleanValue,
  defineSetting,
  enumValue,
  rejectValue,
  type SettingDescriptor,
  type SettingValidation
} from './kernel'

/** Light, dark, or follow the desktop. */
export type ThemeModePreference = 'system' | 'light' | 'dark'

export const THEME_MODE_KEY = 'theme.mode'
export const THEME_NAME_KEY = 'theme.name'
export const THEME_REACTIVE_KEY = 'theme.reactive'
export const THEME_OVERRIDES_KEY = 'theme.overrides'

/**
 * A theme id is *not* validated against the shipped list.
 *
 * Any non-empty string is accepted, because a build that no longer ships a
 * theme must not delete the operator's choice of it — they may be moving
 * between builds, and `computeTheme` already renders the default while
 * reporting `themeMissing`. Rejecting here would turn "this theme is not in
 * this build" into "this theme is gone", which is the unknown-key rule wearing
 * a different hat.
 */
function themeIdValue(): (raw: unknown) => SettingValidation<string> {
  return (raw) => {
    if (typeof raw !== 'string') return rejectValue('not a string')
    const trimmed = raw.trim()
    if (trimmed.length === 0) return rejectValue('empty')
    if (trimmed.length > 64) return rejectValue('too long')
    return acceptValue(trimmed)
  }
}

/**
 * Overrides validate through the theme layer's own parser, which keeps entries
 * naming tokens this build does not define and drops only what could not be a
 * token value at all. Never rejects: a corrupt blob resolves to "no overrides",
 * because a settings row that refuses to load is a window that will not paint.
 */
function overridesValue(): (raw: unknown) => SettingValidation<ThemeOverrides> {
  return (raw) => acceptValue(parseOverrides(raw))
}

export const THEME_SETTINGS: readonly SettingDescriptor[] = [
  defineSetting<ThemeModePreference>({
    key: THEME_MODE_KEY,
    scope: 'durable',
    // See the header: theme keys travel as an `.osctheme`, not in a profile.
    portable: false,
    default: 'system',
    validate: enumValue<ThemeModePreference>(['system', 'light', 'dark']),
    control: {
      kind: 'select',
      options: [
        { value: 'system', label: 'Match system' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }
      ]
    },
    category: 'theme',
    label: 'Mode',
    help: 'Follow the desktop setting, or pin one.',
    keywords: ['dark mode', 'light mode', 'appearance', 'theme'],
    order: 10
  }),

  defineSetting<string>({
    key: THEME_NAME_KEY,
    scope: 'durable',
    // See the header: theme keys travel as an `.osctheme`, not in a profile.
    portable: false,
    default: DEFAULT_THEME_ID,
    // v2: the default theme's id moved from `fermata` to `oscine` in the rename.
    // The theme is otherwise unchanged, so a profile holding the old id is
    // rewritten to the new one — without this the id survives (any string is
    // accepted here) but `findTheme` misses it and the theme reads as missing.
    // Every other stored id, built-in or not, passes through untouched.
    version: 2,
    upgrade: (value) => (value === LEGACY_DEFAULT_THEME_ID ? DEFAULT_THEME_ID : value),
    validate: themeIdValue(),
    // A custom control rather than a static `select`: the picker merges the
    // built-in themes with the operator's dropped-in `.osctheme` files, which
    // are read at runtime and cannot live in a compile-time options list. See
    // `ThemePickerControl.vue`.
    control: { kind: 'custom', component: 'themePicker' },
    category: 'theme',
    label: 'Theme',
    help: 'Each theme carries its own light and dark variant.',
    keywords: ['theme', 'palette', 'colours', 'colors', 'appearance', 'high contrast'],
    order: 20
  }),

  /*
   * The *toggle* is durable; what it produces is not. The seed itself never
   * reaches this registry — it lives on `ThemeInputs` in the renderer, because
   * it is derived from whatever happens to be playing. Persisting it would let
   * one album overwrite an authored theme and would ship that album's colour to
   * another machine in the W8-13 bundle as though it had been chosen.
   */
  defineSetting<boolean>({
    key: THEME_REACTIVE_KEY,
    scope: 'durable',
    // See the header: theme keys travel as an `.osctheme`, not in a profile.
    portable: false,
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'theme',
    label: 'Reactive color',
    help: 'Take the accent from the cover art of whatever is playing. An accent you have set yourself in the token editor still wins.',
    keywords: [
      'reactive',
      'adaptive',
      'accent',
      'album art',
      'cover',
      'colour',
      'color',
      'dynamic'
    ],
    order: 25
  }),

  /*
   * One key holding a map, rather than a row per token — T6. Atomic, exports as
   * one blob, and keeping an override for a token the current theme does not
   * define costs nothing. The price is that per-token revert and provenance are
   * the editor's job rather than inherited from the W8-5/W8-7 machinery.
   *
   * `control: 'custom'` is the escape hatch W8-6 built and deliberately left
   * empty; this is the first entry in it. A map has no generic control, and
   * inventing one would be worse than naming a component.
   */
  defineSetting<ThemeOverrides>({
    key: THEME_OVERRIDES_KEY,
    scope: 'durable',
    // See the header: theme keys travel as an `.osctheme`, not in a profile.
    portable: false,
    default: {},
    validate: overridesValue(),
    control: { kind: 'custom', component: 'themeEditor' },
    category: 'theme',
    label: 'Token overrides',
    help: 'Author your own colors, shape, type and motion over the selected theme.',
    keywords: ['token', 'override', 'custom', 'colour', 'color', 'font', 'radius', 'editor'],
    order: 30
  })
]
