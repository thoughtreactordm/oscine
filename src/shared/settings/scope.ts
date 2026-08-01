/**
 * Where a durable value is keyed, and the shapes that carry one across IPC.
 *
 * A durable key's value is stored per *scope*: the global one every read falls
 * back to, plus — for keys that declare a `cascade` — one row per entity that
 * overrides it. W8-5 is what resolves a cascade; W8-2 lays in the addressing so
 * the primary key never has to be retrofitted, and stores the rows faithfully in
 * the meantime.
 */

import { SETTING_ENTITY_KINDS, type SettingEntityKind, type SettingNotice } from './kernel'

/**
 * The `scope_kind` column's domain.
 *
 * `global` is not a `SettingEntityKind` because there is no entity: it is the
 * base of the cascade rather than a step in it, and its `scope_id` is null.
 */
export const SETTING_SCOPE_KINDS = ['global', ...SETTING_ENTITY_KINDS] as const

export type SettingScopeKind = (typeof SETTING_SCOPE_KINDS)[number]

/** One addressable place a value can live. */
export interface SettingScopeRef {
  kind: SettingScopeKind
  /** Null exactly when `kind` is `global`. */
  id: number | null
}

/**
 * A scope a *particular* key accepts, in the type rather than at runtime.
 *
 * The card's "asking for an override on a non-cascading key is a type error":
 * given a descriptor whose `cascade` is `['album', 'playlist']`, this resolves to
 * the global scope or an album or playlist one, and `{ kind: 'track', id: 7 }`
 * fails to compile. The narrowing only reaches callers holding a directly
 * imported descriptor; through `SETTINGS_REGISTRY` the kinds are erased and
 * `assertCascadeScope` is what catches the same mistake.
 *
 * `id` is non-null for an entity and null for global, which is the same rule
 * `SettingScopeRef` states in prose — here it is checked.
 */
export type CascadeScopeRef<C extends readonly SettingEntityKind[] = readonly SettingEntityKind[]> =
  { readonly kind: 'global'; readonly id: null } | { readonly kind: C[number]; readonly id: number }

/**
 * Typed as the literal global scope rather than as a `SettingScopeRef`, so that
 * it satisfies `CascadeScopeRef<C>` for every `C`. Widening it to the erased
 * shape would make the base of every cascade the one layer a caller could not
 * write down without a cast.
 */
export const GLOBAL_SCOPE: { readonly kind: 'global'; readonly id: null } = Object.freeze({
  kind: 'global',
  id: null
})

export function isGlobalScope(scope: SettingScopeRef): boolean {
  return scope.kind === 'global'
}

export function sameScope(a: SettingScopeRef, b: SettingScopeRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

/**
 * A stable string for a scope, for use as a map key.
 *
 * The global scope is `global` rather than `global:null` so it reads in a log.
 */
export function scopeKey(scope: SettingScopeRef): string {
  return isGlobalScope(scope) ? 'global' : `${scope.kind}:${scope.id}`
}

// --- wire shapes -------------------------------------------------------------

/** One key's new value, in the scope it changed in. */
export interface SettingsChange {
  key: string
  scope: SettingScopeRef
  /** Post-validation, so a repaired value is the repaired one. */
  value: unknown
}

export interface GetAllSettingsResult {
  /** Every durable key resolved at global scope — defaults included. */
  values: Record<string, unknown>
  /**
   * What did not survive the load, verbatim.
   *
   * Carried in the response rather than pushed as an event because the load
   * happens before the window exists: an event would have nobody to reach.
   */
  notices: SettingNotice[]
}

export interface SetSettingRequest {
  key: string
  value: unknown
  /** Omitted means global. */
  scope?: SettingScopeRef
}

/**
 * Reset one key, one category, or everything.
 *
 * `key` wins over `category`; neither means every durable key. Resetting never
 * touches a stored key that has no descriptor — those are somebody else's branch
 * and are preserved, not cleared.
 */
export interface ResetSettingsRequest {
  key?: string
  category?: string
  /** Omitted means global. */
  scope?: SettingScopeRef
}
