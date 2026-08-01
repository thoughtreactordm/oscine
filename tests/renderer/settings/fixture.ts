import {
  createViewSettings,
  memoryViewStorage,
  VIEW_STORAGE_PREFIX
} from '../../../src/renderer/settings/viewStore'

/**
 * A real view store over a memory area, seeded as a previous session left it.
 *
 * The modules that used to take a `browserXyzStorage` take this instead. It is
 * the real store rather than a stub on purpose: the whole claim of W8-3 is that
 * there is one answer to "what may a stored blob contain", and a test double
 * with its own answer would be the sixth copy.
 */
export function viewSettingsFixture(seed: Readonly<Record<string, unknown>> = {}) {
  const entries: Record<string, string> = {}
  for (const [key, value] of Object.entries(seed)) {
    entries[VIEW_STORAGE_PREFIX + key] = JSON.stringify({ value, version: 1 })
  }
  const storage = memoryViewStorage(entries)
  return { storage, settings: createViewSettings({ storage, debounceMs: 0 }) }
}

/** One key's stored value, unwrapped from its entry. */
export function storedValue(storage: { read(key: string): string | null }, key: string): unknown {
  const raw = storage.read(VIEW_STORAGE_PREFIX + key)
  return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value
}
