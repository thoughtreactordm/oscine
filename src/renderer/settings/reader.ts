import type { WritableComputedRef } from 'vue'
import type {
  CascadeScopeRef,
  SettingCascade,
  SettingDescriptor,
  SettingEntityKind,
  SettingScopeRef,
  SettingValidation
} from '@shared/settings'

/**
 * The narrowest thing a consumer of settings needs.
 *
 * Panels, the playback controller and anything else that binds to a key take
 * this rather than the whole store, for the reason the repo takes injected
 * dependencies everywhere else: a module that only reads two keys should not
 * have to be handed a hydration promise, a notice list and an IPC bridge to be
 * testable. `ViewSettings` satisfies it, and so does the unified store, so a
 * consumer that only touches view keys can still be driven by a bare view store
 * under the node test config.
 *
 * Reading through `get` inside a `computed` is reactive; `value` is the same
 * thing pre-wrapped for `v-model`. Neither is a snapshot — that is the whole
 * point of W8-4, and a consumer that copies a value into a plain `ref` at init
 * has opted out of it.
 */
export interface SettingsReader {
  /** The current value, reactive. Throws for a key with no descriptor. */
  get<T>(key: string): T
  /** One two-way binding, for `v-model` and for a `computed` over it. */
  value<T>(key: string): WritableComputedRef<T>
}

/**
 * The same, for a consumer that reads a key *at an entity*.
 *
 * Split from `SettingsReader` rather than folded into it because `ViewSettings`
 * satisfies that one and must not satisfy this: a view key is about this machine
 * and there is no entity for it to cascade to. A consumer asking for this is
 * asking for the durable half, and saying so in its dependency type is how it
 * gets told at compile time rather than at first playback.
 *
 * `cascade` is reactive in the same way `get` is — it reads the same refs — so a
 * caller wraps it in `computed` and a change to the global, or to the entity's
 * own row, reaches it.
 */
export interface CascadingSettingsReader extends SettingsReader {
  /**
   * Fetch an entity's override rows. Idempotent, and safe to leave unawaited.
   *
   * Until it resolves, `cascade` reports what the entity inherits. That is the
   * right thing to show — and the wrong thing to write, which is why nothing
   * does.
   */
  loadOverrides(scope: SettingScopeRef): Promise<void>
  /** True once `loadOverrides` has answered for this scope. */
  overridesLoaded(scope: SettingScopeRef): boolean
  cascade<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): SettingCascade<T>
}

/**
 * The reader plus the two writes an override control makes.
 *
 * What `useCascade` binds to. Narrower than the whole store for the reason
 * `SettingsReader` is: a control that sets and reverts one key should not need a
 * hydration promise and a notice list handed to it to be testable.
 */
export interface CascadingSettings extends CascadingSettingsReader {
  setOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>,
    value: T
  ): Promise<SettingValidation<T>>
  clearOverride<T, C extends readonly SettingEntityKind[]>(
    descriptor: SettingDescriptor<T, C>,
    scope: CascadeScopeRef<C>
  ): Promise<void>
}
