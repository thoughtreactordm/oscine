import type { WritableComputedRef } from 'vue'

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
