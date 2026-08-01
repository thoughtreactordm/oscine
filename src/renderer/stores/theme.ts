import { useColorMode } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { THEME_KEY, type ThemeMode as ThemeModeSetting } from '@shared/settings'
import { useSettings } from '@renderer/settings'
import { currentTheme, onThemeChange, updateTheme } from '@renderer/theme'
import type { ThemeState } from '@renderer/theme'

/**
 * The seam between three things that each think they own light and dark.
 *
 * Nuxt UI's Vite plugin injects a colour-mode plugin that calls VueUse's
 * `useDark()`. That is what puts `.dark` on the document and what
 * `UColorModeSwitch` writes through — it is not something this app opted into,
 * and it works. Meanwhile `interface.theme` is the durable, exportable
 * preference, and the token layer needs to know which variant to resolve.
 *
 * Rather than compete, each owns one thing:
 *
 * - **VueUse owns the class and the system query.** `useColorMode()` here is
 *   the *same* store Nuxt UI's stub wraps — same `vueuse-color-scheme` key — so
 *   reading it is reading exactly what the switch wrote. Nothing here toggles
 *   `.dark`; `applyTheme` sets it from this same resolved value, so the two can
 *   only ever agree.
 * - **The durable setting owns persistence.** localStorage is VueUse's cache;
 *   `interface.theme` is what survives to another machine in W8-13.
 * - **The token layer owns everything else** — which colours a mode resolves to.
 *
 * The two preference stores are synced in both directions, each guarded by an
 * equality check so a write cannot echo back and loop.
 */
export const useThemeStore = defineStore('theme', () => {
  const settings = useSettings()
  const colorMode = useColorMode()
  const state = ref<ThemeState>(currentTheme())

  onThemeChange((next) => {
    state.value = next
  })

  /** Nuxt UI spells "follow the system" `auto`; everything else here says `system`. */
  const preference = computed<ThemeModeSetting>(() =>
    colorMode.store.value === 'auto' ? 'system' : colorMode.store.value
  )

  // The durable setting is the source of truth on the way in: it is what was
  // restored from SQLite, and localStorage is only a cache of it.
  watch(
    () => settings.get<ThemeModeSetting>(THEME_KEY),
    (durable) => {
      if (durable !== preference.value) {
        colorMode.store.value = durable === 'system' ? 'auto' : durable
      }
    },
    { immediate: true }
  )

  // ...and the mirror, so the switch persists. Without this the operator flips
  // the switch, it works, and the choice is gone on the next machine.
  watch(preference, (next) => {
    if (settings.get<ThemeModeSetting>(THEME_KEY) !== next) {
      void settings.set(THEME_KEY, next)
    }
  })

  // The token layer takes the preference and the system answer from the same
  // place the class comes from, so the variant and the class cannot disagree.
  watchEffect(() => {
    updateTheme({
      mode: preference.value,
      systemDark: colorMode.system.value === 'dark'
    })
  })

  return {
    state,
    /** The variant showing right now, after `system` has been answered. */
    mode: computed(() => state.value.mode),
    /** The operator's preference, which may be `system`. */
    preference,
    themeId: computed(() => state.value.themeId),
    themeMissing: computed(() => state.value.themeMissing)
  }
})
