/**
 * Installing the theme, and the one place the current inputs live.
 *
 * A module-level singleton rather than a Pinia store because this has to run
 * *before* `createApp`. The very first paint has to be themed — Electron shows
 * the window on `ready-to-show`, which fires after that paint, so anything
 * applied synchronously here is applied before the operator can see anything at
 * all. A store created during app setup would be too late and would reintroduce
 * exactly the flash this card exists to remove.
 *
 * The store in `stores/theme.ts` wraps this for the components that need to
 * read or change it; it does not own it.
 */

import type { ThemeOverrides } from '@shared/theme'
import { applyTheme } from './applyTheme'
import { computeTheme, DEFAULT_INPUTS, type ThemeInputs, type ThemeState } from './themeController'

let inputs: ThemeInputs = DEFAULT_INPUTS
let state: ThemeState = computeTheme(inputs)

const listeners = new Set<(state: ThemeState) => void>()

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const DARK_SCHEME = '(prefers-color-scheme: dark)'

/**
 * VueUse's colour-mode key, which Nuxt UI's colour-mode plugin already writes.
 *
 * Read directly, by name, because this runs before `createApp` — the composable
 * needs an app context that does not exist yet. That is not a workaround: it is
 * the pre-paint replay, and it comes free because the preference is already
 * persisted somewhere synchronously readable.
 *
 * Nuxt UI spells "follow the system" as `auto` where the rest of this app spells
 * it `system`; the translation lives here and in the store, and nowhere else.
 */
const VUEUSE_COLOR_SCHEME = 'vueuse-color-scheme'

function storedPreference(): ThemeInputs['mode'] {
  try {
    const stored = window.localStorage.getItem(VUEUSE_COLOR_SCHEME)
    if (stored === 'light' || stored === 'dark') return stored
    return 'system'
  } catch {
    // Reading storage can throw when it is disabled or full. A theme that
    // failed to paint because it could not read a preference would be a much
    // worse outcome than one that starts on the system default.
    return 'system'
  }
}

function render(): void {
  state = computeTheme(inputs)
  applyTheme(state)
  for (const listener of listeners) listener(state)
}

/**
 * Reduced motion stays a media query even after the main process takes over
 * dark/light. `nativeTheme` reports colour preference and nothing else, and
 * Chromium already maps the OS setting onto this query on both platforms.
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches
}

/**
 * Paint the theme before the app exists.
 *
 * The mode comes from the same persisted preference Nuxt UI's colour-mode
 * plugin uses, so the first paint matches what `useDark()` will settle on a
 * moment later and there is nothing to flash between. Once the app is up, the
 * store takes over and this stops being the source of the mode — see the
 * ownership note there.
 */
export function installTheme(): void {
  inputs = {
    ...inputs,
    mode: storedPreference(),
    systemDark: window.matchMedia(DARK_SCHEME).matches,
    systemReducedMotion: prefersReducedMotion()
  }
  render()

  /*
   * Chromium maps the OS colour preference onto this query on both platforms.
   * VueUse watches the same query, so after mount the two agree by
   * construction; this listener is what keeps the pre-mount window correct and
   * what answers `system` if the store is ever not mounted.
   */
  window.matchMedia(DARK_SCHEME).addEventListener('change', (event) => {
    updateTheme({ systemDark: event.matches })
  })

  window.matchMedia(REDUCED_MOTION).addEventListener('change', (event) => {
    updateTheme({ systemReducedMotion: event.matches })
  })
}

/** Patch the inputs and repaint. Live preview is this and nothing else. */
export function updateTheme(patch: Partial<ThemeInputs>): void {
  inputs = { ...inputs, ...patch }
  render()
}

export function currentTheme(): ThemeState {
  return state
}

export function currentInputs(): ThemeInputs {
  return inputs
}

export function onThemeChange(listener: (state: ThemeState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export { applyTheme, applyModeOnly } from './applyTheme'
export {
  computeTheme,
  resolveMode,
  windowBackground,
  DEFAULT_INPUTS,
  type ThemeInputs,
  type ThemeModePreference,
  type ThemeState
} from './themeController'
export type { ThemeOverrides }
