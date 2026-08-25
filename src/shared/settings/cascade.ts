/**
 * Cascade resolution: `descriptor.default` → `global` row → entity override row.
 *
 * One resolution path for every "this playlist plays differently" case. Fermata
 * used to carry one by hand — `playlists.crossfade_ms`, with its own column and
 * its own IPC channel — and the cost of that shape is not the column, it is that
 * every future per-entity value would reinvent the "is this inherited or set
 * here?" affordance alongside it.
 *
 * Nothing here reads or writes. It is handed the rows that exist and returns the
 * value plus **provenance** — which level supplied it — because a UI cannot
 * render the override affordance without knowing. That is the whole reason this
 * is a module and not a `??` chain.
 *
 * ## The three states a control must be able to draw
 *
 * - **inheriting**: no row at this level. `overridden` is false, `value` equals
 *   `inherited`, and `provenance` names where it came from.
 * - **overridden here**: a row at this level with a different value.
 *   `overridden` is true and `inherited` is what reverting would restore.
 * - **set here and equal to inherited**: a row at this level holding the value it
 *   would have inherited anyway. `overridden` is still true. Collapsing this into
 *   "inheriting" would silently discard the operator's explicit choice the moment
 *   the global moved, which is exactly the case they set it to survive.
 */

import {
  migrateValue,
  resolveDefault,
  type SettingDescriptor,
  type SettingEntityKind,
  type SettingNotice,
  type StoredSetting
} from './kernel'
import {
  GLOBAL_SCOPE,
  isGlobalScope,
  sameScope,
  scopeKey,
  type CascadeScopeRef,
  type SettingScopeRef
} from './scope'

/** Which level supplied a value. */
export type SettingProvenance =
  { readonly level: 'default' } | { readonly level: 'stored'; readonly scope: SettingScopeRef }

export const DEFAULT_PROVENANCE: SettingProvenance = Object.freeze({ level: 'default' })

export function storedProvenance(scope: SettingScopeRef): SettingProvenance {
  return Object.freeze({ level: 'stored' as const, scope: Object.freeze({ ...scope }) })
}

export function sameProvenance(a: SettingProvenance, b: SettingProvenance): boolean {
  if (a.level !== b.level) return false
  return a.level === 'default' || sameScope(a.scope, (b as { scope: SettingScopeRef }).scope)
}

/**
 * A phrase naming a level, for the "inherited from …" line.
 *
 * Deliberately does not name the entity — the pure layer knows a playlist's id
 * and not its title, and a resolver that had to be handed display names to
 * answer a question about values would be the wrong shape. The renderer
 * substitutes the title it already has.
 */
export function provenanceLabel(provenance: SettingProvenance): string {
  if (provenance.level === 'default') return 'the built-in default'
  return isGlobalScope(provenance.scope)
    ? 'the global setting'
    : `the ${provenance.scope.kind} override`
}

/** One addressable level, and whatever row is actually at it. */
export interface CascadeLayer<
  C extends readonly SettingEntityKind[] = readonly SettingEntityKind[]
> {
  readonly scope: CascadeScopeRef<C>
  /** Null when no row exists at this scope. */
  readonly stored: StoredSetting | null
}

export interface SettingCascade<T> {
  readonly key: string
  /** The value in effect. */
  readonly value: T
  /** Where `value` came from. */
  readonly provenance: SettingProvenance
  /**
   * A surviving row exists at the most specific level asked about.
   *
   * "Surviving" matters: a row this build rejects is not an override, it is a
   * damaged one, and a control that drew a revert affordance over it would offer
   * to revert to the value already on screen.
   */
  readonly overridden: boolean
  /** What `value` would be with the most specific level's row dropped. */
  readonly inherited: T
  readonly inheritedFrom: SettingProvenance
  /** Rows that did not survive, most specific first. */
  readonly notices: readonly SettingNotice[]
}

/**
 * The scope this key actually accepts, checked at runtime.
 *
 * The type-level guard is `CascadeScopeRef`, and it is the one that should
 * normally fire. This exists for the callers the registry erases — an IPC
 * request naming a key and a scope, both of them strings until something checks.
 * A `RangeError` rather than a `OscineError`: by the time a scope reaches the
 * pure layer, main's `assertScope` has already turned a bad request into a
 * polite refusal, so anything arriving here is a bug in this repo.
 */
export function assertCascadeScope(descriptor: SettingDescriptor, scope: SettingScopeRef): void {
  // Compared inline rather than through `isGlobalScope`, which is not a type
  // predicate: the narrowing to the entity kinds is what the next line needs.
  if (scope.kind === 'global') {
    if (scope.id !== null) throw new RangeError('the global scope has no id')
    return
  }
  if (!descriptor.cascade.includes(scope.kind)) {
    throw new RangeError(`setting "${descriptor.key}" cannot be overridden per ${scope.kind}`)
  }
  if (!Number.isInteger(scope.id) || (scope.id as number) < 1) {
    throw new RangeError(`a ${scope.kind} scope needs a positive id`)
  }
}

/** Finds a stored row for a scope, or reports that there is none. */
export type StoredLookup = (scope: SettingScopeRef) => StoredSetting | null

/**
 * The layers for one entity, most specific first.
 *
 * The card's cascade is three levels and this builds the two that can hold a
 * row; `resolveCascade` supplies the default underneath them. Asking at the
 * global scope yields one layer, which is the degenerate and entirely valid
 * case: "is there a global row, or is this still the shipped default?" is the
 * same question one level up.
 */
export function cascadeLayers<T, C extends readonly SettingEntityKind[]>(
  descriptor: SettingDescriptor<T, C>,
  scope: CascadeScopeRef<C>,
  lookup: StoredLookup
): CascadeLayer<C>[] {
  assertCascadeScope(descriptor, scope)
  const layers: CascadeLayer<C>[] = []
  if (!isGlobalScope(scope)) layers.push({ scope, stored: lookup(scope) })
  layers.push({ scope: GLOBAL_SCOPE, stored: lookup(GLOBAL_SCOPE) })
  return layers
}

/**
 * Walk the layers, most specific first, and report what won.
 *
 * A layer whose row this build cannot read — rejected by the validator, damaged,
 * or written by a newer build — falls through to the *next layer* rather than to
 * the default. That is the difference between a cascade and a lookup: a corrupt
 * per-playlist crossfade should leave the playlist playing the global value, not
 * reset it to shipped-gapless while a perfectly good global row sits unread one
 * level down.
 *
 * `layers` is ordered and the order is load-bearing, so it is checked rather
 * than trusted: a caller that put the global layer first would get answers that
 * look plausible and are backwards.
 */
export function resolveCascade<T, C extends readonly SettingEntityKind[]>(
  descriptor: SettingDescriptor<T, C>,
  layers: readonly CascadeLayer<C>[]
): SettingCascade<T> {
  assertLayerOrder(descriptor, layers)

  const notices: SettingNotice[] = []
  /** Layer index → the value it contributes. Absent means it contributes none. */
  const accepted = new Map<number, T>()

  layers.forEach((layer, index) => {
    if (layer.stored === null) return
    const resolved = migrateValue(descriptor, layer.stored)
    if (resolved.notice) {
      notices.push({
        ...resolved.notice,
        reason: `${resolved.notice.reason} (at ${scopeKey(layer.scope)})`
      })
      return
    }
    accepted.set(index, resolved.value)
  })

  const winner = (from: number): { value: T; provenance: SettingProvenance } => {
    for (let index = from; index < layers.length; index += 1) {
      if (accepted.has(index)) {
        return {
          value: accepted.get(index) as T,
          provenance: storedProvenance(layers[index].scope)
        }
      }
    }
    return { value: resolveDefault(descriptor), provenance: DEFAULT_PROVENANCE }
  }

  const effective = winner(0)
  const inherited = winner(1)

  return {
    key: descriptor.key,
    value: effective.value,
    provenance: effective.provenance,
    overridden: accepted.has(0),
    inherited: inherited.value,
    inheritedFrom: inherited.provenance,
    notices
  }
}

/**
 * The one shape a caller can get wrong silently.
 *
 * Most-specific-first with global last, no repeats. Everything else about a
 * layer list is either checked by `assertCascadeScope` or does not matter.
 */
function assertLayerOrder(descriptor: SettingDescriptor, layers: readonly CascadeLayer[]): void {
  if (layers.length === 0) throw new RangeError('a cascade needs at least one layer')

  const seen = new Set<string>()
  layers.forEach((layer, index) => {
    assertCascadeScope(descriptor, layer.scope)
    const key = scopeKey(layer.scope)
    if (seen.has(key)) throw new RangeError(`cascade names ${key} twice`)
    seen.add(key)
    if (isGlobalScope(layer.scope) && index !== layers.length - 1) {
      throw new RangeError('the global layer is the least specific and must come last')
    }
  })
}
