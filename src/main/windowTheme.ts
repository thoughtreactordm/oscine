/**
 * The colour the window paints before the renderer has drawn anything.
 *
 * `backgroundColor: '#0a0a0a'` shipped with the comment "matches the dark
 * surface token so launch does not flash white", and named a token that did not
 * exist. This is what makes that claim true, and keeps it true across three
 * themes, two variants and whatever the operator has overridden: the value is
 * read from the same resolver the renderer uses, so the two cannot drift.
 *
 * ## Why there is no IPC here
 *
 * The plan called for the main process to own the resolved mode and push it to
 * the renderer. After the colour-mode ownership split that is redundant — the
 * renderer gets its mode from VueUse, synchronously, and would only be waiting
 * on a channel to be told what it already knows.
 *
 * What main genuinely needs is to paint a window *before the renderer exists*,
 * and it needs no new surface to do that: the settings service is constructed
 * before the window precisely so anything below it can read a durable setting,
 * and it already reports writes through `onChanged`. So this reads three keys
 * and answers a colour. No channel, no handler, no preload change.
 */

import {
  THEME_MODE_KEY,
  THEME_NAME_KEY,
  THEME_OVERRIDES_KEY,
  type ThemeModePreference
} from '@shared/settings'
import {
  DEFAULT_THEME_ID,
  findTheme,
  parseColor,
  parseOverrides,
  resolveTheme,
  toHex,
  type ThemeMode
} from '@shared/theme'

/** The keys that move this colour, so a caller can filter a change list. */
export const WINDOW_BACKGROUND_KEYS: readonly string[] = [
  THEME_MODE_KEY,
  THEME_NAME_KEY,
  THEME_OVERRIDES_KEY
]

/**
 * The narrowest thing this needs from the settings service.
 *
 * Taking a reader rather than the service keeps it testable without a database,
 * the same reason `SettingsReader` exists on the renderer side.
 */
export interface DurableReader {
  get<T>(key: string): T
}

/**
 * Last resort if the resolver somehow yields no surface — which it cannot for a
 * built-in, since `resolveTheme` falls back to the default theme's ramps.
 * Black rather than the old `#0a0a0a`: an unexplained near-black that happens
 * to look like a theme is harder to notice than one that plainly is not.
 */
const FALLBACK = '#000000'

export function resolveWindowBackground(read: DurableReader, systemDark: boolean): string {
  const preference = read.get<ThemeModePreference>(THEME_MODE_KEY)
  const mode: ThemeMode = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  const theme = findTheme(read.get<string>(THEME_NAME_KEY)) ?? findTheme(DEFAULT_THEME_ID)
  if (!theme) return FALLBACK

  const { tokens } = resolveTheme({
    theme,
    mode,
    overrides: parseOverrides(read.get(THEME_OVERRIDES_KEY))
  })

  const surface = tokens.get('surface.base')
  const parsed = surface ? parseColor(surface) : null
  /*
   * Hex, not the `oklch()` the token holds: Chromium's `setBackgroundColor`
   * takes a CSS colour string but the window is painted by the compositor
   * before any stylesheet exists, and hex is the form it reliably understands.
   */
  return parsed ? toHex(parsed) : FALLBACK
}

/*
 * There is deliberately no `nativeTheme` import in this file.
 *
 * It is the only thing here that would need Electron, and keeping it out means
 * the module is pure: it tests under plain Node against a hand-built reader,
 * with no dependency on how Electron's CJS shim happens to interop when there
 * is no Electron. The two triggers — a theme key changing, and the OS flipping
 * while the preference is `system` — are wired where the window lives.
 */
