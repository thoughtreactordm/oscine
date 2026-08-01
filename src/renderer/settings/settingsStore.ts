import {
  computed,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref,
  type WritableComputedRef
} from 'vue'
import {
  acceptValue,
  GLOBAL_SCOPE,
  rejectValue,
  resolveDefault,
  SETTINGS_REGISTRY,
  validateValue,
  type GetAllSettingsResult,
  type ResetSettingsRequest,
  type SetSettingRequest,
  type SettingDescriptor,
  type SettingNotice,
  type SettingsChange,
  type SettingValidation
} from '@shared/settings'
import type { SettingsReader } from './reader'
import type { ViewSettings } from './viewStore'

/**
 * One reactive surface over both halves of the split.
 *
 * The registry says what a key is, `SqliteSettingsService` and `ViewSettings`
 * say where it lives, and this says what it *is right now* — flat, keyed by
 * registry key, and reactive, so that a consumer binds once and a change made
 * anywhere reaches it. There is no staging buffer and no apply step: a `set`
 * lands in the surface before it lands on disk, which is what makes "settings
 * apply immediately" true rather than "settings apply next launch".
 *
 * Propagation and persistence are deliberately different speeds. A value is
 * visible to every consumer synchronously; the write behind it is debounced,
 * because a slider drag emits on every pointer move and the only thing that
 * should feel that is SQLite.
 *
 * ## Why this is not a `defineStore`
 *
 * W8-4 sketched a Pinia store. It is a module singleton instead, for the two
 * reasons `useViewSettings` already documents: a setup store unwraps the refs
 * its returned object holds, so `notices` would arrive at consumers as an array
 * where the type says `Ref`, and the shell reads settings while deciding what
 * to paint, which is not guaranteed to be after Pinia is installed. Pinia
 * stores that need it call `useSettings()` in their setup and get the same
 * instance.
 */

/**
 * How long durable writes coalesce for.
 *
 * Longer than the view store's window: a durable write crosses IPC and lands in
 * SQLite, where the view store's lands in a synchronous key-value area.
 */
export const DURABLE_WRITE_DEBOUNCE_MS = 200

/** Main's half of the surface. Satisfied by `@renderer/ipc`'s `settings`. */
export interface DurableSettingsBridge {
  getAll(): Promise<GetAllSettingsResult>
  set(request: SetSettingRequest): Promise<SettingsChange[]>
  reset(request: ResetSettingsRequest): Promise<SettingsChange[]>
  /** Returns an unsubscribe function. */
  onChanged(listener: (changes: SettingsChange[]) => void): () => void
}

export interface SettingsStoreDeps {
  durable: DurableSettingsBridge
  view: ViewSettings
  /**
   * Which keys this store owns. Defaults to the whole registry.
   *
   * Present for the same reason `resolveSettings` and `createViewSettings` take
   * one: every shipped key is at version 1 and none is `requiresRestart`, so a
   * hand-built registry is the only way to exercise either path.
   */
  descriptors?: readonly SettingDescriptor[]
  /** Zero writes through, which is what a test wants. */
  debounceMs?: number
}

export interface SettingsStore extends SettingsReader {
  /** The current value, reactive, for a key in either scope. */
  get<T>(key: string): T
  /**
   * Validate, propagate, and persist.
   *
   * Resolves with what was actually stored — main revalidates, and a repaired
   * value is the repaired one. A rejection is a resolved `{ ok: false }` rather
   * than a thrown error, matching how the kernel reports one and keeping a
   * fire-and-forget caller (a `v-model` binding) from raising an unhandled
   * rejection.
   */
  set<T>(key: string, value: T): Promise<SettingValidation<T>>
  /** Drop the stored value so the key resumes tracking its descriptor default. */
  reset(key: string): Promise<void>
  value<T>(key: string): WritableComputedRef<T>
  /** Writes anything either half's debounce is still holding. */
  flush(): Promise<void>
  /** False until `settings.getAll` has landed. Durable keys read defaults until then. */
  readonly hydrated: Ref<boolean>
  /** Resolves once hydration has finished, successfully or not. */
  readonly ready: Promise<void>
  /** What did not survive a load, and what a write was refused for. */
  readonly notices: ComputedRef<readonly SettingNotice[]>
  /**
   * Keys whose value has moved since the process started *and* whose descriptor
   * is flagged `requiresRestart`.
   *
   * Derived from the flag, never from a list: a key gains a badge by declaring
   * one. The store does not otherwise treat these keys differently — they are
   * written, propagated and read exactly like every other key, and the flag only
   * says the running process will not act on the new value.
   */
  readonly restartRequired: ComputedRef<readonly string[]>
  readonly descriptors: readonly SettingDescriptor[]
  dispose(): void
}

interface PendingWrite {
  value: unknown
  resolvers: ((result: SettingValidation<unknown>) => void)[]
}

/** Structural equality, enough for the small values settings hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const { durable, view } = deps
  const descriptors = deps.descriptors ?? SETTINGS_REGISTRY
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const debounceMs = deps.debounceMs ?? DURABLE_WRITE_DEBOUNCE_MS

  const ownNotices = shallowRef<readonly SettingNotice[]>([])
  const hydrated = ref(false)

  /**
   * Durable values only — view keys are read through the view store, which is
   * already reactive and already the authority on them. Two copies of a value
   * is one copy too many, and the second one is always the stale one.
   *
   * Replaced wholesale rather than mutated, and shallow, for the reason
   * `ViewSettings` gives: a deep ref would hand out a proxy of a stored object
   * and a caller that mutated it would get a re-render and no write.
   */
  const state = shallowRef<Record<string, unknown>>({})

  /** What main last confirmed, so a refused write has something to fall back to. */
  const confirmed: Record<string, unknown> = {}

  /** Every key as of process start, for `restartRequired`. */
  const launch = shallowRef<Record<string, unknown>>({})

  const pending = new Map<string, PendingWrite>()
  const inFlight = new Set<string>()
  /** Keys a broadcast has already spoken for, so hydration cannot undo one. */
  const broadcast = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function descriptorFor(key: string): SettingDescriptor {
    const descriptor = byKey.get(key)
    if (!descriptor) throw new RangeError(`unknown setting: ${key}`)
    return descriptor
  }

  function currentValue(descriptor: SettingDescriptor): unknown {
    return descriptor.scope === 'view' ? view.get(descriptor.key) : state.value[descriptor.key]
  }

  function note(notice: SettingNotice): void {
    ownNotices.value = [...ownNotices.value, notice]
  }

  for (const descriptor of descriptors) {
    if (descriptor.scope !== 'durable') continue
    const value = resolveDefault(descriptor)
    state.value[descriptor.key] = value
    confirmed[descriptor.key] = value
  }
  launch.value = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.key, currentValue(descriptor)])
  )

  /**
   * Write a durable value into the surface, unless something newer is queued.
   *
   * Every path that is not a caller's own `set` goes through here — the
   * reconcile after a write, the rollback after a refusal, a reset — and none of
   * them may clobber an optimistic value the operator has since typed.
   */
  function apply(key: string, value: unknown): void {
    if (pending.has(key)) return
    if (sameValue(state.value[key], value)) return
    state.value = { ...state.value, [key]: value }
  }

  function settle(entry: PendingWrite, result: SettingValidation<unknown>): void {
    for (const resolve of entry.resolvers) resolve(result)
    entry.resolvers.length = 0
  }

  async function hydrate(): Promise<void> {
    let result: GetAllSettingsResult
    try {
      result = await durable.getAll()
    } catch (error) {
      // A window that cannot reach main still has to paint. Defaults are already
      // in the surface; this only records why they are what the operator sees.
      note({
        key: 'settings.getAll',
        reason: `durable settings could not be loaded: ${(error as Error).message}`,
        rejected: null
      })
      hydrated.value = true
      return
    }

    const next = { ...state.value }
    const launched = { ...launch.value }
    for (const [key, value] of Object.entries(result.values)) {
      const descriptor = byKey.get(key)
      if (!descriptor || descriptor.scope !== 'durable') continue
      confirmed[key] = value
      // What main held at startup, which is what a restart badge compares
      // against — including for a key written before this response arrived.
      launched[key] = value
      // A write or a broadcast that raced the hydration is newer than the answer
      // to a question asked before either of them.
      if (pending.has(key) || inFlight.has(key) || broadcast.has(key)) continue
      next[key] = value
    }

    state.value = next
    launch.value = launched
    if (result.notices.length) ownNotices.value = [...ownNotices.value, ...result.notices]
    hydrated.value = true
  }

  /**
   * A change main is announcing — ours echoed back, or another window's.
   *
   * This is the half of the loop that must not close. It writes the surface and
   * nothing else: no `enqueue`, no `set`, no path back out to main. A renderer
   * change echoed here therefore settles on the value it already had rather than
   * emitting a second write, and two windows cannot volley one key between them.
   */
  function applyRemote(changes: readonly SettingsChange[]): void {
    let next: Record<string, unknown> | null = null

    for (const change of changes) {
      // Per-entity overrides are W8-5's; this surface has one slot per key and
      // that slot holds the global value.
      if (change.scope.kind !== 'global') continue
      const descriptor = byKey.get(change.key)
      if (!descriptor || descriptor.scope !== 'durable') continue

      confirmed[change.key] = change.value
      broadcast.add(change.key)
      if (pending.has(change.key) || inFlight.has(change.key)) continue
      if (sameValue(state.value[change.key], change.value)) continue

      next ??= { ...state.value }
      next[change.key] = change.value
    }

    if (next) state.value = next
  }

  function enqueue(key: string, value: unknown): Promise<SettingValidation<unknown>> {
    const existing = pending.get(key)
    const entry: PendingWrite = existing ?? { value, resolvers: [] }
    entry.value = value
    if (!existing) pending.set(key, entry)

    const settled = new Promise<SettingValidation<unknown>>((resolve) => {
      entry.resolvers.push(resolve)
    })
    schedule()
    return settled
  }

  function schedule(): void {
    if (debounceMs <= 0) {
      void flush()
      return
    }
    // The window is not restarted by a later change, so a drag that keeps
    // emitting still persists every debounce interval rather than only when the
    // pointer comes up. Same reasoning as the view store's.
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, debounceMs)
  }

  async function flush(): Promise<void> {
    view.flush()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return

    const batch = [...pending.entries()]
    pending.clear()
    await Promise.all(batch.map(([key, entry]) => write(key, entry)))
  }

  async function write(key: string, entry: PendingWrite): Promise<void> {
    inFlight.add(key)
    try {
      const changes = await durable.set({ key, value: entry.value, scope: GLOBAL_SCOPE })
      const change = changes.find((one) => one.key === key && one.scope.kind === 'global')
      // Main revalidates rather than trusting the renderer's pass, and a repaired
      // value is what actually got stored. Reconciling to it is what keeps an
      // optimistic surface honest.
      const stored = change ? change.value : entry.value
      confirmed[key] = stored
      apply(key, stored)
      settle(entry, acceptValue(stored))
    } catch (error) {
      const reason = (error as Error).message
      note({ key, reason: `the write was refused: ${reason}`, rejected: entry.value })
      // The optimistic value never happened, so it does not get to stay on
      // screen looking like it did.
      apply(key, confirmed[key])
      settle(entry, rejectValue(reason))
    } finally {
      inFlight.delete(key)
    }
  }

  function get<T>(key: string): T {
    return currentValue(descriptorFor(key)) as T
  }

  function set<T>(key: string, next: T): Promise<SettingValidation<T>> {
    const descriptor = descriptorFor(key)

    // Validated here as well as in main, so a control learns it was refused
    // without a round trip — and so a repair (a clamp) is what the operator sees
    // move under their pointer rather than a value that snaps back later.
    const resolved = validateValue(descriptor, next)
    if (resolved.notice) {
      note(resolved.notice)
      return Promise.resolve(rejectValue<T>(resolved.notice.reason))
    }
    const value = resolved.value as T

    if (descriptor.scope === 'view') {
      // The view store owns its own debounce, notices and storage. Handing it an
      // already-validated value keeps one notice per rejection rather than two.
      view.set(key, value)
      return Promise.resolve(acceptValue(value))
    }

    // Propagation is immediate; only the write behind it is deferred. Assigned
    // directly rather than through `apply`, which exists to stop *other* paths
    // from overtaking a queued write — a caller's own set is that write.
    if (!sameValue(state.value[key], value)) state.value = { ...state.value, [key]: value }
    return enqueue(key, value) as Promise<SettingValidation<T>>
  }

  async function reset(key: string): Promise<void> {
    const descriptor = descriptorFor(key)
    if (descriptor.scope === 'view') {
      view.reset(key)
      return
    }

    // A queued write for a key being reset is moot, but its callers are still
    // waiting on an answer.
    const dropped = pending.get(key)
    pending.delete(key)
    const fallback = resolveDefault(descriptor)

    try {
      applyRemote(await durable.reset({ key, scope: GLOBAL_SCOPE }))
      // Main answers with a change only when the value actually moved, so the
      // already-at-default case has to be settled here rather than by the echo.
      confirmed[key] = fallback
      apply(key, fallback)
      if (dropped) settle(dropped, acceptValue(fallback))
    } catch (error) {
      const reason = (error as Error).message
      note({ key, reason: `the reset was refused: ${reason}`, rejected: null })
      if (dropped) settle(dropped, rejectValue(reason))
      throw error
    }
  }

  function value<T>(key: string): WritableComputedRef<T> {
    descriptorFor(key)
    return computed({
      get: () => get<T>(key),
      set: (next: T) => {
        void set(key, next)
      }
    })
  }

  const notices = computed<readonly SettingNotice[]>(() => [
    ...ownNotices.value,
    ...view.notices.value
  ])

  const restartRequired = computed<readonly string[]>(() =>
    descriptors
      .filter(
        (descriptor) =>
          descriptor.requiresRestart &&
          !sameValue(currentValue(descriptor), launch.value[descriptor.key])
      )
      .map((descriptor) => descriptor.key)
  )

  // Subscribed before hydrating rather than after, so a change main makes while
  // the first `getAll` is in flight is seen rather than missed.
  const off = durable.onChanged(applyRemote)
  const ready = hydrate()

  function dispose(): void {
    // Disposing is not a reason to lose a write the debounce is still holding.
    void flush()
    off()
  }

  return {
    get,
    set,
    reset,
    value,
    flush,
    hydrated,
    ready,
    notices,
    restartRequired,
    descriptors,
    dispose
  }
}
