/**
 * Writing the resolved theme onto the document.
 *
 * The only module in the app that touches `document` for theming, and it is
 * kept trivial on purpose — everything worth testing lives in
 * `themeController.ts`, which is DOM-free and unit-tested; this is verified in
 * the live run.
 *
 * Custom properties go on `documentElement` as inline styles rather than into
 * an injected `<style>` sheet. Inline properties beat any `:root` rule
 * regardless of stylesheet order, so the bridge cannot accidentally win against
 * the values it is supposed to be reading — and removing a property is a real
 * removal rather than a cascade question.
 */

import type { ThemeMode } from '@shared/theme'
import type { ThemeState } from './themeController'

/**
 * What we set last time, so a token that stops being defined is removed rather
 * than left behind. Reverting an override has to actually revert it.
 */
let applied: readonly string[] = []

export function applyTheme(state: ThemeState): void {
  const root = document.documentElement
  const next = state.resolved.cssVars

  for (const name of applied) {
    if (!next.has(name)) root.style.removeProperty(name)
  }
  for (const [name, value] of next) {
    root.style.setProperty(name, value)
  }
  applied = [...next.keys()]

  setMode(root, state.mode)
}

/**
 * Nuxt UI switches on a class — `@variant dark (&:where(.dark, .dark *))` — so
 * the class is the mechanism, not a convention we could choose differently.
 *
 * `color-scheme` goes with it. It is what makes native form controls, the
 * default scrollbar and the window's own chrome follow the theme; without it a
 * dark app renders light-mode select popups.
 */
function setMode(root: HTMLElement, mode: ThemeMode): void {
  root.classList.toggle('dark', mode === 'dark')
  root.classList.toggle('light', mode === 'light')
  root.style.colorScheme = mode
}

/**
 * The pre-paint replay's counterpart: the same class and `color-scheme`, set
 * from a cached mode before Vue has mounted or any token is known.
 *
 * Exported so the inline bootstrap in `index.html` and the store agree on what
 * "apply a mode" means rather than each having their own idea.
 */
export function applyModeOnly(mode: ThemeMode): void {
  setMode(document.documentElement, mode)
}
