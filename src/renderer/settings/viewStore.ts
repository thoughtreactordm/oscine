import { computed, shallowRef, type Ref, type WritableComputedRef } from 'vue'
import {
  resolveDefault,
  resolveSettings,
  sameSettingValue,
  settingsInScope,
  validateValue,
  type SettingDescriptor,
  type SettingNotice,
  type StoredSetting
} from '@shared/settings'
import type { SettingsReader } from './reader'

/**
 * The `view` half of the settings store: one flat-key backend for every key
 * that is about *this machine*.
 *
 * Before this there were five of these — `browserLayoutStorage`,
 * `browserShellLayoutStorage`, `browserTransportStorage`,
 * `browserPlaylistSessionStorage`, `browserPodcastSessionStorage` — each a
 * guard around the browser's own storage, a JSON `try`/`catch` and a
 * field-by-field normalize-on-read written from scratch. The guard and the
 * `try`/`catch` are here; the normalizing is in each key's descriptor, where a
 * value's shape is stated once for both processes.
 *
 * Storage stays injected, which is the part of the old design worth keeping: it
 * is why the modules above this are unit-testable without a DOM. Nothing in
 * this file reaches the browser either — `browserViewStorage` does, and it is
 * the only module in `src/` that names the global.
 *
 * Read synchronously at construction, unlike the durable half. The shell has to
 * paint its own pane sizes on the first frame, and a layout that arrives one
 * IPC round-trip later is a layout that visibly snaps into place.
 */

/**
 * Namespaced per key rather than one blob.
 *
 * One entry per key is what makes a key from a neighbouring branch survive: this
 * store never reads or writes an entry it has no descriptor for, so switching
 * builds cannot destroy the other one's settings. A single blob would have to
 * carry the unknown entries back to disk by hand on every write, and would lose
 * the lot to one quota failure instead of one key.
 */
export const VIEW_STORAGE_PREFIX = 'fermata.view.'

/** How long writes coalesce for. A pane drag emits on every pointer move. */
export const VIEW_WRITE_DEBOUNCE_MS = 250

/**
 * A flat string-keyed store. The browser's own is one; a `Map` is another.
 *
 * Deliberately not `Storage`: that type is DOM-only, and these modules compile
 * under the node config too.
 */
export interface ViewStorageArea {
  read(key: string): string | null
  write(key: string, value: string): void
  remove(key: string): void
}

/** A `ViewStorageArea` backed by a plain map, for tests and for a headless run. */
export function memoryViewStorage(
  seed: Readonly<Record<string, string>> = {}
): ViewStorageArea & { readonly entries: Map<string, string>; readonly writes: number } {
  const entries = new Map(Object.entries(seed))
  let writes = 0
  return {
    entries,
    get writes() {
      return writes
    },
    read: (key) => entries.get(key) ?? null,
    write: (key, value) => {
      writes += 1
      entries.set(key, value)
    },
    remove: (key) => {
      entries.delete(key)
    }
  }
}

export interface ViewSettingsDeps {
  storage?: ViewStorageArea
  /**
   * Which keys this store owns. Defaults to every `view`-scoped descriptor.
   *
   * Present for the same reason `resolveSettings` takes one: a test needs to be
   * able to exercise the store against a hand-built registry.
   */
  descriptors?: readonly SettingDescriptor[]
  /** Zero writes through, which is what a test wants. */
  debounceMs?: number
}

export interface ViewSettings extends SettingsReader {
  /** The current value, reactive. Throws for a key with no descriptor. */
  get<T>(key: string): T
  /**
   * An entry for this key survived the load or has been written since. Reactive.
   *
   * The durable half tracks the same thing as `storedKeys`, and W8-7 needs both:
   * a revert affordance is only offered where there is a row to delete, and an
   * entry holding exactly the default is such a row. The value alone cannot say
   * — that is the same blind spot `GetAllSettingsResult.storedKeys` exists for.
   */
  stored(key: string): boolean
  /** Validates, repairs and stores. A rejected value falls back to the default. */
  set<T>(key: string, value: T): void
  /** Back to the default, and stop storing an entry for it. */
  reset(key: string): void
  /** One two-way binding, for `v-model` and for a `computed` over it. */
  value<T>(key: string): WritableComputedRef<T>
  /** Writes anything the debounce is still holding. */
  flush(): void
  /** What did not survive the load, and what a `set` refused since. */
  readonly notices: Ref<readonly SettingNotice[]>
  readonly descriptors: readonly SettingDescriptor[]
}

export function createViewSettings(deps: ViewSettingsDeps = {}): ViewSettings {
  const storage = deps.storage
  const descriptors = deps.descriptors ?? settingsInScope('view')
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const debounceMs = deps.debounceMs ?? VIEW_WRITE_DEBOUNCE_MS

  const notices = shallowRef<readonly SettingNotice[]>([])
  /**
   * Replaced wholesale rather than mutated, and shallow.
   *
   * A deep `ref` would hand out a reactive proxy of a stored object, and a
   * caller that mutated it would get a re-render and no write — a bug that
   * looks like it worked. Values here are snapshots; `set` is the only way to
   * change one.
   */
  const state = shallowRef<Record<string, unknown>>({})

  /**
   * Which keys an entry actually supplied a value for.
   *
   * A key whose entry was rejected is not among them: `state` holds the fallback
   * default, and calling that "stored" would attribute it to an entry that
   * supplied nothing — the same rule main's `stored` set follows.
   */
  const storedKeys = shallowRef<ReadonlySet<string>>(new Set())

  /** Keys whose stored entry is behind `state`, waiting on the debounce. */
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function descriptorFor(key: string): SettingDescriptor {
    const descriptor = byKey.get(key)
    if (!descriptor) throw new RangeError(`unknown view setting: ${key}`)
    return descriptor
  }

  function note(notice: SettingNotice): void {
    notices.value = [...notices.value, notice]
  }

  /**
   * One key's stored entry, or null.
   *
   * An entry that is not JSON, or is JSON of the wrong shape, is a notice
   * rather than a value. Handing the raw string to a string key's validator
   * would let a corrupt entry through as an ordinary string and the operator
   * would never learn it was damaged — the same reasoning `SettingsStore`
   * applies to a malformed row.
   */
  function readEntry(key: string): StoredSetting | null {
    const raw = storage?.read(VIEW_STORAGE_PREFIX + key)
    if (raw === null || raw === undefined) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      note({
        key,
        reason: `stored entry is not valid JSON: ${(error as Error).message}`,
        rejected: raw
      })
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || !('value' in parsed)) {
      note({ key, reason: 'stored entry is not a { value, version } record', rejected: parsed })
      return null
    }

    const entry = parsed as { value: unknown; version?: unknown }
    return { value: entry.value, version: typeof entry.version === 'number' ? entry.version : 1 }
  }

  function load(): void {
    const stored: Record<string, StoredSetting> = {}
    for (const descriptor of descriptors) {
      const entry = readEntry(descriptor.key)
      if (entry) stored[descriptor.key] = entry
    }

    const resolution = resolveSettings(stored, 'view', descriptors)
    state.value = resolution.values
    const rejected = new Set(resolution.notices.map((notice) => notice.key))
    storedKeys.value = new Set(Object.keys(stored).filter((key) => !rejected.has(key)))
    if (resolution.notices.length) notices.value = [...notices.value, ...resolution.notices]
    // A repaired or migrated entry is stale on disk. Rewritten through the same
    // debounce as everything else, so a cold start does not fire a burst of
    // synchronous writes before the first frame.
    for (const key of resolution.rewrite) pending.add(key)
    if (pending.size) schedule()
  }

  function schedule(): void {
    if (debounceMs <= 0) return flush()
    // The window is not restarted by a later change: a drag that keeps emitting
    // would otherwise persist nothing at all until the pointer came up.
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, debounceMs)
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    for (const key of pending) {
      const descriptor = byKey.get(key)
      if (!descriptor) continue
      storage?.write(
        VIEW_STORAGE_PREFIX + key,
        JSON.stringify({ value: state.value[key], version: descriptor.version })
      )
    }
    pending.clear()
  }

  function get<T>(key: string): T {
    descriptorFor(key)
    return state.value[key] as T
  }

  function stored(key: string): boolean {
    descriptorFor(key)
    return storedKeys.value.has(key)
  }

  function markStored(key: string, present: boolean): void {
    if (storedKeys.value.has(key) === present) return
    const next = new Set(storedKeys.value)
    if (present) next.add(key)
    else next.delete(key)
    storedKeys.value = next
  }

  function set<T>(key: string, next: T): void {
    const descriptor = descriptorFor(key)
    const resolved = validateValue(descriptor, next)
    if (resolved.notice) note(resolved.notice)
    // A no-op set writes nothing. Callers hand this clamped values from a drag,
    // and most pointer moves land on the number already stored.
    if (sameSettingValue(state.value[key], resolved.value)) return
    state.value = { ...state.value, [key]: resolved.value }
    markStored(key, true)
    pending.add(key)
    schedule()
  }

  function reset(key: string): void {
    const descriptor = descriptorFor(key)
    state.value = { ...state.value, [key]: resolveDefault(descriptor) }
    // Forgotten rather than stored as the default, so that a later build which
    // changes the default reaches a profile that never overrode it.
    pending.delete(key)
    markStored(key, false)
    storage?.remove(VIEW_STORAGE_PREFIX + key)
  }

  function value<T>(key: string): WritableComputedRef<T> {
    descriptorFor(key)
    return computed({ get: () => get<T>(key), set: (next: T) => set(key, next) })
  }

  load()

  return { get, stored, set, reset, value, flush, notices, descriptors }
}
