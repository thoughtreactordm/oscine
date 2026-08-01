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
  cascadeLayers,
  GLOBAL_SCOPE,
  isGlobalScope,
  rejectValue,
  resolveCascade,
  resolveDefault,
  scopeKey,
  SETTINGS_REGISTRY,
  validateValue,
  type CascadeScopeRef,
  type GetAllSettingsResult,
  type GetSettingOverridesRequest,
  type GetSettingOverridesResult,
  type ResetSettingsRequest,
  type SetSettingRequest,
  type SettingCascade,
  type SettingDescriptor,
  type SettingEntityKind,
  type SettingNotice,
  type SettingScopeRef,
  type SettingsChange,
  type SettingValidation,
  type StoredSetting
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
 * ## Two axes, not one
 *
 * W8-5 added the second: a durable key has a value at the global scope and,
 * where it cascades, a value per entity. The flat surface still holds exactly
 * the global values — one slot per key — and override rows live beside it in
 * `overrides`, addressed by scope. Everything that writes is therefore keyed by
 * *key and scope* rather than by key: two windows editing the same playlist's
 * crossfade must coalesce, and a window editing the global while another edits a
 * playlist must not.
 *
 * Resolution across the two is `resolveCascade`'s, and it happens here rather
 * than in main so that moving the global re-resolves every entity that inherits
 * it without a round trip.
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
  getOverrides(request: GetSettingOverridesRequest): Promise<GetSettingOverridesResult>
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
   * one: every shipped key is at version 1, so a hand-built registry is the only
   * way to exercise the migration path at all — and the only shipped
   * `requiresRestart` key is `library.artworkCacheMb`, so a badge test written
   * against the real registry would fail the day that flag moved.
   */
  descriptors?: readonly SettingDescriptor[]
  /** Zero writes through, which is what a test wants. */
  debounceMs?: number
}

export interface SettingsStore extends SettingsReader {
  /** The current global value, reactive, for a key in either scope. */
  get<T>(key: string): T
  /**
   * Validate, propagate, and persist — at the global scope.
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

  /**
   * Fetch one scope's override rows into the surface. Idempotent.
   *
   * Called by anything about to read a cascade at that scope. Until it resolves,
   * `cascade` reports what the entity would inherit — which is the right answer
   * to show while loading and the wrong one to persist, so nothing writes it.
   */
  loadOverrides(scope: SettingScopeRef): Promise<void>
  /** True once `loadOverrides` has answered for this scope. */
  overridesLoaded(scope: SettingScopeRef): boolean
  /**
   * Resolve one key at one scope: value, provenance, and what reverting gives.
   *
   * Reactive by construction — it reads the same refs `get` does — so a caller
   * wraps it in `computed` exactly as it would `get`.
   */
  cascade<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): SettingCascade<T>
  /** Write an override row at an entity scope. */
  setOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>,
    value: T
  ): Promise<SettingValidation<T>>
  /** Drop the override row so the entity resumes inheriting. */
  clearOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): Promise<void>

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

/** One queued write, and everyone waiting to hear how it went. */
interface PendingWrite {
  key: string
  scope: SettingScopeRef
  value: unknown
  resolvers: ((result: SettingValidation<unknown>) => void)[]
}

/** Structural equality, enough for the small values settings hold. */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The identity of a write target.
 *
 * Everything queued, in flight or spoken for by a broadcast is tracked under
 * this rather than under the bare key. A playlist override and the global it
 * inherits from are two independent rows, and coalescing them would make setting
 * one silently discard a queued write to the other.
 */
function writeKey(key: string, scope: SettingScopeRef): string {
  return `${scopeKey(scope)}::${key}`
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const { durable, view } = deps
  const descriptors = deps.descriptors ?? SETTINGS_REGISTRY
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const debounceMs = deps.debounceMs ?? DURABLE_WRITE_DEBOUNCE_MS

  const ownNotices = shallowRef<readonly SettingNotice[]>([])
  const hydrated = ref(false)

  /**
   * Durable *global* values only — view keys are read through the view store,
   * which is already reactive and already the authority on them. Two copies of a
   * value is one copy too many, and the second one is always the stale one.
   *
   * Replaced wholesale rather than mutated, and shallow, for the reason
   * `ViewSettings` gives: a deep ref would hand out a proxy of a stored object
   * and a caller that mutated it would get a re-render and no write.
   */
  const state = shallowRef<Record<string, unknown>>({})

  /**
   * Which global values came from a row rather than from the descriptor default.
   *
   * The cascade needs it: a global row holding exactly the default and no global
   * row at all produce the same number and different provenance, and only one of
   * them has anything to reset.
   */
  const storedGlobals = shallowRef<ReadonlySet<string>>(new Set())

  /** Override rows, by `scopeKey` then by setting key. Raw, as main holds them. */
  const overrides = shallowRef<Record<string, Record<string, StoredSetting>>>({})

  /** Scopes `loadOverrides` has answered for, and the fetches still in flight. */
  const loadedScopes = ref(new Set<string>())
  const loadingScopes = new Map<string, Promise<void>>()

  /** What main last confirmed, by write target. Null means "no row there". */
  const confirmed = new Map<string, { value: unknown } | null>()

  /** Every key as of process start, for `restartRequired`. */
  const launch = shallowRef<Record<string, unknown>>({})

  const pending = new Map<string, PendingWrite>()
  const inFlight = new Set<string>()
  /** Targets a broadcast has already spoken for, so a load cannot undo one. */
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
    confirmed.set(writeKey(descriptor.key, GLOBAL_SCOPE), { value })
  }
  launch.value = Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.key, currentValue(descriptor)])
  )

  // --- reading the cascade ----------------------------------------------------

  /**
   * The row at one level, as `resolveCascade` wants it.
   *
   * The global layer is synthesised from the already-resolved value rather than
   * kept as a second raw copy: main migrated and validated it before answering
   * `getAll`, so the value in the surface *is* what that row resolves to, and it
   * is at this build's version by construction. Keeping the raw row alongside it
   * would be the stale second copy this store exists to avoid.
   */
  function storedAt(descriptor: SettingDescriptor, level: SettingScopeRef): StoredSetting | null {
    if (isGlobalScope(level)) {
      return storedGlobals.value.has(descriptor.key)
        ? { value: state.value[descriptor.key], version: descriptor.version }
        : null
    }
    return overrides.value[scopeKey(level)]?.[descriptor.key] ?? null
  }

  function cascade<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): SettingCascade<T> {
    if (descriptor.scope !== 'durable') {
      throw new RangeError(`setting "${descriptor.key}" is view-scoped and does not cascade`)
    }
    return resolveCascade(
      descriptor,
      cascadeLayers(descriptor, scope, (level) => storedAt(descriptor, level))
    )
  }

  function overridesLoaded(scope: SettingScopeRef): boolean {
    return isGlobalScope(scope) || loadedScopes.value.has(scopeKey(scope))
  }

  function loadOverrides(scope: SettingScopeRef): Promise<void> {
    if (isGlobalScope(scope)) return Promise.resolve()
    const scoped = scopeKey(scope)
    if (loadedScopes.value.has(scoped)) return Promise.resolve()

    const running = loadingScopes.get(scoped)
    if (running) return running

    const load = durable
      .getOverrides({ scope })
      .then((result) => {
        const next: Record<string, StoredSetting> = { ...overrides.value[scoped] }
        for (const [key, entry] of Object.entries(result.stored)) {
          const descriptor = byKey.get(key)
          if (!descriptor || descriptor.scope !== 'durable') continue
          // A write or a broadcast that raced the fetch is newer than the answer
          // to a question asked before either of them — the same rule `hydrate`
          // follows for the global half.
          const target = writeKey(key, scope)
          if (pending.has(target) || inFlight.has(target) || broadcast.has(target)) continue
          next[key] = entry
        }
        overrides.value = { ...overrides.value, [scoped]: next }
        if (result.notices.length) ownNotices.value = [...ownNotices.value, ...result.notices]
      })
      .catch((error: Error) => {
        // A scope whose overrides could not be fetched inherits, which is what
        // the surface already shows. Recording why is all that is left to do.
        note({
          key: `settings.getOverrides(${scoped})`,
          reason: `overrides could not be loaded: ${error.message}`,
          rejected: null
        })
      })
      .finally(() => {
        loadingScopes.delete(scoped)
        // Marked loaded even after a failure: retrying on every read would turn
        // one unreachable main into a request per frame.
        loadedScopes.value = new Set(loadedScopes.value).add(scoped)
      })

    loadingScopes.set(scoped, load)
    return load
  }

  // --- writing ----------------------------------------------------------------

  /**
   * Write a value into the surface, unless something newer is queued.
   *
   * Every path that is not a caller's own `set` goes through here — the
   * reconcile after a write, the rollback after a refusal, a reset — and none of
   * them may clobber an optimistic value the operator has since typed.
   */
  function apply(key: string, scope: SettingScopeRef, value: unknown): void {
    if (pending.has(writeKey(key, scope))) return

    if (isGlobalScope(scope)) {
      if (sameValue(state.value[key], value)) return
      state.value = { ...state.value, [key]: value }
      return
    }

    const scoped = scopeKey(scope)
    if (sameValue(overrides.value[scoped]?.[key]?.value, value)) return
    overrides.value = {
      ...overrides.value,
      [scoped]: {
        ...overrides.value[scoped],
        [key]: { value, version: descriptorFor(key).version }
      }
    }
  }

  /**
   * Whether a global key has a row, tracked apart from its value.
   *
   * Not folded into `apply`: a rollback and a reset both write a value into the
   * surface while *removing* the row that value came from, and a marker that
   * moved with every assignment could not express that.
   */
  function markGlobalRow(key: string, present: boolean): void {
    if (storedGlobals.value.has(key) === present) return
    const next = new Set(storedGlobals.value)
    if (present) next.add(key)
    else next.delete(key)
    storedGlobals.value = next
  }

  /** Drop a row from the surface. The cascade then resolves one level down. */
  function drop(key: string, scope: SettingScopeRef): void {
    if (pending.has(writeKey(key, scope))) return

    if (isGlobalScope(scope)) {
      markGlobalRow(key, false)
      // Nothing under the global row but the default, so that is what applies.
      state.value = { ...state.value, [key]: resolveDefault(descriptorFor(key)) }
      return
    }

    const scoped = scopeKey(scope)
    if (overrides.value[scoped]?.[key] === undefined) return
    const { [key]: _dropped, ...rest } = overrides.value[scoped]
    overrides.value = { ...overrides.value, [scoped]: rest }
  }

  /** Put the surface back where main last confirmed it — including "no row". */
  function rollback(key: string, scope: SettingScopeRef): void {
    const last = confirmed.get(writeKey(key, scope)) ?? null
    if (last === null) {
      drop(key, scope)
      return
    }
    apply(key, scope, last.value)
    if (isGlobalScope(scope)) markGlobalRow(key, true)
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
      const target = writeKey(key, GLOBAL_SCOPE)
      confirmed.set(target, result.storedKeys.includes(key) ? { value } : null)
      // What main held at startup, which is what a restart badge compares
      // against — including for a key written before this response arrived.
      launched[key] = value
      // A write or a broadcast that raced the hydration is newer than the answer
      // to a question asked before either of them.
      if (pending.has(target) || inFlight.has(target) || broadcast.has(target)) continue
      next[key] = value
    }

    state.value = next
    launch.value = launched
    storedGlobals.value = new Set(
      result.storedKeys.filter((key) => byKey.get(key)?.scope === 'durable')
    )
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
    for (const change of changes) {
      const descriptor = byKey.get(change.key)
      if (!descriptor || descriptor.scope !== 'durable') continue
      // An entity scope this window has never asked about is not cached, and
      // caching it from a broadcast alone would leave a half-populated scope that
      // `loadOverrides` then believes is complete.
      if (!isGlobalScope(change.scope) && !overridesLoaded(change.scope)) continue

      const target = writeKey(change.key, change.scope)
      broadcast.add(target)

      // `cleared` is what tells "set to 2000" from "override dropped, now
      // inherits 2000". Both carry the same value and mean opposite things.
      if (change.cleared) {
        confirmed.set(target, null)
        if (!pending.has(target) && !inFlight.has(target)) {
          drop(change.key, change.scope)
          if (isGlobalScope(change.scope)) apply(change.key, change.scope, change.value)
        }
        continue
      }

      confirmed.set(target, { value: change.value })
      if (pending.has(target) || inFlight.has(target)) continue
      apply(change.key, change.scope, change.value)
      if (isGlobalScope(change.scope)) markGlobalRow(change.key, true)
    }
  }

  function enqueue(
    key: string,
    scope: SettingScopeRef,
    value: unknown
  ): Promise<SettingValidation<unknown>> {
    const target = writeKey(key, scope)
    const existing = pending.get(target)
    const entry: PendingWrite = existing ?? { key, scope, value, resolvers: [] }
    entry.value = value
    if (!existing) pending.set(target, entry)

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
    await Promise.all(batch.map(([target, entry]) => write(target, entry)))
  }

  async function write(target: string, entry: PendingWrite): Promise<void> {
    const { key, scope } = entry
    inFlight.add(target)
    try {
      const changes = await durable.set({ key, value: entry.value, scope })
      const change = changes.find(
        (one) => one.key === key && scopeKey(one.scope) === scopeKey(scope)
      )
      // Main revalidates rather than trusting the renderer's pass, and a repaired
      // value is what actually got stored. Reconciling to it is what keeps an
      // optimistic surface honest.
      const stored = change ? change.value : entry.value
      confirmed.set(target, { value: stored })
      apply(key, scope, stored)
      if (isGlobalScope(scope)) markGlobalRow(key, true)
      settle(entry, acceptValue(stored))
    } catch (error) {
      const reason = (error as Error).message
      note({ key, reason: `the write was refused: ${reason}`, rejected: entry.value })
      // The optimistic value never happened, so it does not get to stay on
      // screen looking like it did.
      rollback(key, scope)
      settle(entry, rejectValue(reason))
    } finally {
      inFlight.delete(target)
    }
  }

  function get<T>(key: string): T {
    return currentValue(descriptorFor(key)) as T
  }

  /** Validate here as well as in main, so a control learns it was refused
   * without a round trip — and so a repair (a clamp) is what the operator sees
   * move under their pointer rather than a value that snaps back later. */
  function checked<T>(descriptor: SettingDescriptor, next: T): SettingValidation<T> {
    const resolved = validateValue(descriptor, next)
    if (resolved.notice) {
      note(resolved.notice)
      return rejectValue<T>(resolved.notice.reason)
    }
    return acceptValue(resolved.value as T)
  }

  function set<T>(key: string, next: T): Promise<SettingValidation<T>> {
    const descriptor = descriptorFor(key)

    const validated = checked(descriptor, next)
    if (!validated.ok) return Promise.resolve(validated)
    const value = validated.value

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
    markGlobalRow(key, true)
    return enqueue(key, GLOBAL_SCOPE, value) as Promise<SettingValidation<T>>
  }

  function setOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>,
    next: T
  ): Promise<SettingValidation<T>> {
    if (isGlobalScope(scope)) return set(descriptor.key, next)
    // Throws on a scope the key does not cascade to, rather than queueing a write
    // main is certain to refuse.
    cascadeLayers(descriptor, scope, () => null)

    const validated = checked(descriptor, next)
    if (!validated.ok) return Promise.resolve(validated)

    const scoped = scopeKey(scope)
    overrides.value = {
      ...overrides.value,
      [scoped]: {
        ...overrides.value[scoped],
        [descriptor.key]: { value: validated.value, version: descriptor.version }
      }
    }
    return enqueue(descriptor.key, scope, validated.value) as Promise<SettingValidation<T>>
  }

  async function reset(key: string): Promise<void> {
    const descriptor = descriptorFor(key)
    if (descriptor.scope === 'view') {
      view.reset(key)
      return
    }
    await clear(descriptor, GLOBAL_SCOPE)
  }

  function clearOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): Promise<void> {
    if (isGlobalScope(scope)) return reset(descriptor.key)
    cascadeLayers(descriptor, scope, () => null)
    return clear(descriptor, scope)
  }

  /** Drop one row at one scope, and put the surface where that leaves it. */
  async function clear(descriptor: SettingDescriptor, scope: SettingScopeRef): Promise<void> {
    const key = descriptor.key
    const target = writeKey(key, scope)

    // A queued write for a row being dropped is moot, but its callers are still
    // waiting on an answer.
    const dropped = pending.get(target)
    pending.delete(target)

    try {
      applyRemote(await durable.reset({ key, scope }))
      // Main answers with a change only when something actually moved, so the
      // already-absent case has to be settled here rather than by the echo.
      confirmed.set(target, null)
      drop(key, scope)
      // What now applies is one level down, whichever level that was: the global
      // value for an entity, the descriptor default for the global itself.
      if (dropped) settle(dropped, acceptValue(inheritedAfterDrop(descriptor, scope)))
    } catch (error) {
      const reason = (error as Error).message
      note({ key, reason: `the reset was refused: ${reason}`, rejected: null })
      if (dropped) settle(dropped, rejectValue(reason))
      throw error
    }
  }

  /** What applies at a scope once its own row is gone. Read after `drop`. */
  function inheritedAfterDrop(descriptor: SettingDescriptor, scope: SettingScopeRef): unknown {
    return resolveCascade(
      descriptor,
      cascadeLayers(descriptor, scope as CascadeScopeRef, (level) => storedAt(descriptor, level))
    ).value
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
    loadOverrides,
    overridesLoaded,
    cascade,
    setOverride,
    clearOverride,
    flush,
    hydrated,
    ready,
    notices,
    restartRequired,
    descriptors,
    dispose
  }
}
