import {
  GLOBAL_SCOPE,
  resolveDefault,
  SETTINGS_REGISTRY,
  validateValue,
  type ResetSettingsRequest,
  type SetSettingRequest,
  type SettingDescriptor,
  type SettingNotice,
  type SettingsChange
} from '../../../src/shared/settings'
import {
  createSettingsStore,
  type DurableSettingsBridge
} from '../../../src/renderer/settings/settingsStore'
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

export interface DurableBridgeFixture extends DurableSettingsBridge {
  /** What the fake main holds, by key. */
  readonly rows: Map<string, unknown>
  readonly calls: {
    getAll: number
    set: SetSettingRequest[]
    reset: ResetSettingsRequest[]
  }
  /** Resolves the pending `getAll`. Only when the fixture was made deferred. */
  answerGetAll(): void
  /** Push a change as another window's write would arrive. */
  announce(changes: SettingsChange[]): void
}

export interface DurableBridgeOptions {
  /** What main already holds, as `getAll` would resolve it. */
  stored?: Readonly<Record<string, unknown>>
  notices?: SettingNotice[]
  descriptors?: readonly SettingDescriptor[]
  /** Hold `getAll` open so a test can write into an unhydrated store. */
  deferGetAll?: boolean
  /**
   * What main stores in place of what it was asked to store.
   *
   * Not a contrivance: W8-9's gapless/crossfade pair adjusts one key when the
   * other is set, and a build whose descriptor has moved on clamps differently
   * from the renderer that called it. Either way the response is the authority
   * and the optimistic value has to give way to it.
   */
  repair?: (request: SetSettingRequest) => unknown
  /** Refuse a key outright, as an invalid request would be refused. */
  refuse?: (request: SetSettingRequest) => string | null
}

/**
 * A stand-in for `SqliteSettingsService` across the IPC boundary.
 *
 * Faked rather than driven for real because the property under test is the
 * renderer's half of the loop — optimistic write, reconcile, echo — and that
 * needs a main whose answers and whose *timing* a test can name. It validates
 * with the real registry so a value this accepts is one the real service would.
 */
export function durableBridgeFixture(options: DurableBridgeOptions = {}): DurableBridgeFixture {
  const descriptors = options.descriptors ?? SETTINGS_REGISTRY
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const rows = new Map(Object.entries(options.stored ?? {}))
  const listeners = new Set<(changes: SettingsChange[]) => void>()
  const calls = { getAll: 0, set: [] as SetSettingRequest[], reset: [] as ResetSettingsRequest[] }

  let releaseGetAll: (() => void) | null = null

  function announce(changes: SettingsChange[]): void {
    for (const listener of listeners) listener(changes)
  }

  function descriptorFor(key: string): SettingDescriptor {
    const descriptor = byKey.get(key)
    if (!descriptor) throw new Error(`Unknown setting: ${key}`)
    return descriptor
  }

  return {
    rows,
    calls,
    answerGetAll: () => releaseGetAll?.(),
    announce,

    async getAll() {
      calls.getAll += 1
      if (options.deferGetAll) {
        await new Promise<void>((resolve) => {
          releaseGetAll = resolve
        })
      }
      const values: Record<string, unknown> = {}
      for (const descriptor of descriptors) {
        if (descriptor.scope !== 'durable') continue
        values[descriptor.key] = rows.has(descriptor.key)
          ? rows.get(descriptor.key)
          : resolveDefault(descriptor)
      }
      return { values, notices: [...(options.notices ?? [])] }
    },

    async set(request) {
      calls.set.push(request)
      const descriptor = descriptorFor(request.key)

      const refused = options.refuse?.(request)
      if (refused) throw new Error(`${request.key}: ${refused}`)

      // Main revalidates rather than trusting the caller, which is the whole
      // reason the renderer's optimistic value is provisional.
      const resolved = validateValue(descriptor, request.value)
      if (resolved.notice) throw new Error(`${request.key}: ${resolved.notice.reason}`)

      const stored = options.repair ? options.repair(request) : resolved.value
      rows.set(request.key, stored)
      const changes = [{ key: request.key, scope: request.scope ?? GLOBAL_SCOPE, value: stored }]
      // Main broadcasts to every window, the caller's included.
      announce(changes)
      return changes
    },

    async reset(request) {
      calls.reset.push(request)
      const targets =
        request.key !== undefined
          ? [descriptorFor(request.key)]
          : descriptors.filter((descriptor) => descriptor.scope === 'durable')

      const changes: SettingsChange[] = []
      for (const descriptor of targets) {
        if (!rows.delete(descriptor.key)) continue
        changes.push({
          key: descriptor.key,
          scope: request.scope ?? GLOBAL_SCOPE,
          value: resolveDefault(descriptor)
        })
      }
      if (changes.length) announce(changes)
      return changes
    },

    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/**
 * The whole surface — both scopes — over a memory area and a faked main.
 *
 * What a consumer that reads durable *and* view keys is handed in the app. The
 * view half is seeded and inspectable exactly as `viewSettingsFixture` leaves
 * it, so a test that was written against that one only has to change what it
 * constructs.
 */
export function settingsStoreFixture(
  options: DurableBridgeOptions & { seed?: Readonly<Record<string, unknown>> } = {}
) {
  const view = viewSettingsFixture(options.seed)
  const bridge = durableBridgeFixture(options)
  const settings = createSettingsStore({
    durable: bridge,
    view: view.settings,
    debounceMs: 0,
    ...(options.descriptors ? { descriptors: options.descriptors } : {})
  })
  return { settings, storage: view.storage, view: view.settings, bridge }
}

/** One key's stored value, unwrapped from its entry. */
export function storedValue(storage: { read(key: string): string | null }, key: string): unknown {
  const raw = storage.read(VIEW_STORAGE_PREFIX + key)
  return raw === null ? null : (JSON.parse(raw) as { value: unknown }).value
}
