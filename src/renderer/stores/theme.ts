import { defineStore } from 'pinia'
import { computed, watchEffect } from 'vue'
import { THEME_KEY, type ThemeMode as ThemeModeSetting } from '@shared/settings'
import { useSettings } from '@renderer/settings'
import { currentTheme, onThemeChange, updateTheme } from '@renderer/theme'
import type { ThemeState } from '@renderer/theme'
import { ref } from 'vue'

/**
 * The seam between the settings surface and the theme layer.
 *
 * The theme layer itself is a module singleton, installed before `createApp` so
 * the first paint is already themed — see `theme/index.ts`. This store does one
 * job: keep it in step with the durable settings the operator actually edits,
 * and expose the resulting state to components.
 *
 * `watchEffect` rather than a one-time read, because `settings.get` is reactive
 * by design (W8-4) and a consumer that snapshots into a plain `ref` at init has
 * opted out of live propagation. Changing the theme select has to repaint the
 * app without a reload; that is the whole premise.
 */
export const useThemeStore = defineStore('theme', () => {
  const settings = useSettings()
  const state = ref<ThemeState>(currentTheme())

  onThemeChange((next) => {
    state.value = next
  })

  watchEffect(() => {
    updateTheme({ mode: settings.get<ThemeModeSetting>(THEME_KEY) })
  })

  return {
    state,
    /** The variant showing right now, after `system` has been answered. */
    mode: computed(() => state.value.mode),
    /** The operator's preference, which may be `system`. */
    preference: settings.value<ThemeModeSetting>(THEME_KEY),
    themeId: computed(() => state.value.themeId),
    themeMissing: computed(() => state.value.themeMissing)
  }
})
