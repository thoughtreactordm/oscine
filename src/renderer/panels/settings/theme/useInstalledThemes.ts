import { ref } from 'vue'
import { theme as themeIpc } from '@renderer/ipc'
import type { InstalledTheme } from '@shared/theme'

/**
 * The `.osctheme` files in the themes folder, shared across the picker and the
 * theme actions.
 *
 * A module-level ref rather than per-component state, for the same reason the
 * settings store is a singleton: the picker reads the list and the actions
 * change it (an import lands a new file), and the two must agree without one
 * telling the other. The actions call `refresh()` after a write; the picker's
 * dropdown then updates because it is looking at the same ref.
 *
 * The folder is read from main over IPC, so this is lazily loaded once and
 * refreshed on demand — the file set only changes when the operator imports one
 * or drops one in, neither of which is frequent enough to poll for.
 */
const installed = ref<InstalledTheme[]>([])
let loaded = false

export function useInstalledThemes(): {
  installed: typeof installed
  refresh: () => Promise<void>
} {
  async function refresh(): Promise<void> {
    installed.value = await themeIpc.listInstalled()
  }

  if (!loaded) {
    loaded = true
    void refresh()
  }

  return { installed, refresh }
}
