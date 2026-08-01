import { computed, toValue, watch, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import {
  provenanceLabel,
  type CascadeScopeRef,
  type SettingDescriptor,
  type SettingEntityKind,
  type SettingProvenance
} from '@shared/settings'
import type { CascadingSettings } from './reader'

/**
 * One binding for a control editing a cascading key at an entity.
 *
 * The card's UI contract, as a composable rather than as a component: the
 * settings view is W8-6's to draw, and what has to exist first is the thing it
 * draws *from*. A control that had to assemble these five values itself would be
 * reinventing the "is this inherited or set here?" affordance — which is the
 * cost W8-5 exists to stop paying once per per-entity value.
 *
 * ## The three states, in these fields
 *
 * | State | `overridden` | What the control shows |
 * |---|---|---|
 * | inheriting | `false` | `inherited`, greyed, captioned `inheritedFrom` |
 * | overridden here | `true` | `value`, with `revert` offered |
 * | set here, equal to inherited | `true` | the same, and **still** with `revert` offered |
 *
 * The third row is the one worth stating twice. A control that compared `value`
 * to `inherited` and drew the first state when they matched would silently throw
 * away an explicit choice — and it would do it at the exact moment the choice
 * starts to matter, because the two stop matching only when the global moves,
 * which is the thing the operator pinned against. `overridden` is a fact about
 * whether a row exists, never about what is in it.
 */
export interface CascadeBinding<T> {
  /**
   * The value in effect. Assigning writes an override *at this scope*.
   *
   * `v-model` on an entity control is therefore "override this entity", and
   * there is no second verb for it — which is what makes reverting the only
   * other thing a control needs.
   */
  readonly value: ComputedRef<T> & { value: T }
  /** A row exists at this scope, whatever it holds. */
  readonly overridden: ComputedRef<boolean>
  /** What reverting would restore. */
  readonly inherited: ComputedRef<T>
  /** Where `inherited` comes from, as a phrase: "the global setting". */
  readonly inheritedFrom: ComputedRef<string>
  /** The same, unphrased, for a caller that wants to name the entity itself. */
  readonly inheritedProvenance: ComputedRef<SettingProvenance>
  /**
   * False until this scope's rows have arrived.
   *
   * Everything above still reads correctly while it is false — as what the
   * entity would inherit — so a control can render immediately and use this only
   * to decide whether to show a revert affordance it might be about to discover
   * is wrong.
   */
  readonly loaded: ComputedRef<boolean>
  /** Drop the override so the entity resumes inheriting. */
  revert(): Promise<void>
}

/**
 * `scope` may be a getter, so a control bound to "the viewed playlist" follows
 * the selection: changing it re-resolves and fetches the new entity's rows.
 */
export function useCascade<T, C extends readonly SettingEntityKind[]>(
  settings: CascadingSettings,
  descriptor: SettingDescriptor<T, C>,
  scope: MaybeRefOrGetter<CascadeScopeRef<C>>
): CascadeBinding<T> {
  const resolved = computed(() => settings.cascade(descriptor, toValue(scope)))

  // Immediate, because a control that rendered a frame before asking would show
  // the inherited value and then correct itself for no reason.
  watch(
    () => toValue(scope),
    (next) => void settings.loadOverrides(next),
    { immediate: true }
  )

  const value = computed({
    get: () => resolved.value.value,
    set: (next: T) => {
      void settings.setOverride(descriptor, toValue(scope), next)
    }
  })

  return {
    value,
    overridden: computed(() => resolved.value.overridden),
    inherited: computed(() => resolved.value.inherited),
    inheritedFrom: computed(() => provenanceLabel(resolved.value.inheritedFrom)),
    inheritedProvenance: computed(() => resolved.value.inheritedFrom),
    loaded: computed(() => settings.overridesLoaded(toValue(scope))),
    revert: () => settings.clearOverride(descriptor, toValue(scope))
  }
}
