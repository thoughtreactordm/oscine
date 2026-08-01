import { browserViewStorage } from './browserViewStorage'
import { absorbLegacyViewKeys } from './legacyViewKeys'
import { createViewSettings, type ViewSettings } from './viewStore'

export { browserViewStorage } from './browserViewStorage'
export { absorbLegacyViewKeys, LEGACY_VIEW_KEYS, type LegacyViewKey } from './legacyViewKeys'
export {
  createViewSettings,
  memoryViewStorage,
  VIEW_STORAGE_PREFIX,
  VIEW_WRITE_DEBOUNCE_MS,
  type ViewSettings,
  type ViewSettingsDeps,
  type ViewStorageArea
} from './viewStore'

/**
 * The renderer's one view store, built on first use.
 *
 * A module singleton rather than a Pinia store, for two reasons. Pinia's setup
 * stores unwrap the refs a returned object holds, so a store that handed out
 * this one would hand out something that no longer satisfies `ViewSettings` —
 * `notices` would arrive as an array where every consumer expects a ref. And
 * the shell reads pane sizes while it is deciding what to paint, which is
 * before Pinia is necessarily installed.
 *
 * Stores that need it call this in their setup; Pinia memoizes them, so the
 * legacy absorption below runs exactly once per window either way.
 */
let instance: ViewSettings | null = null

export function useViewSettings(): ViewSettings {
  if (instance) return instance

  const storage = browserViewStorage()
  const settings = createViewSettings({ storage })
  absorbLegacyViewKeys(settings, storage)

  // A debounced write that has not fired yet would otherwise be lost on quit.
  // `pagehide` rather than `beforeunload`: Chromium fires it on the paths a
  // desktop window actually closes through.
  globalThis.addEventListener?.('pagehide', () => settings.flush())

  instance = settings
  return instance
}
