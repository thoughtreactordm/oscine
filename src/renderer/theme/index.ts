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

export function installTheme(): void {
  inputs = {
    ...inputs,
    systemReducedMotion: prefersReducedMotion()
  }
  render()

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
