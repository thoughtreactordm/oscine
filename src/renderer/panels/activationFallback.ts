import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'

/**
 * The one rule the two activation settings share.
 *
 * `addToViewedPlaylist` needs a playlist open in Curate, and the operator can
 * make the gesture while there is not one. Doing nothing would read as a broken
 * list — activation is the most-used gesture in the app and silence is
 * indistinguishable from a hang — so it falls back to playing, which is the verb
 * the row would have had if the setting had never been touched. `hint` says so
 * where a surface has room to.
 *
 * Extracted rather than written twice because `trackActivation` and
 * `facetActivation` are two surfaces reading two keys, and the fallback is the
 * part an operator would notice disagreeing: a double-clicked song that plays
 * and a double-clicked album that does nothing, from the same missing playlist,
 * is one bug wearing two costumes.
 *
 * Generic over the action union rather than fixed to `TrackActivation`, because
 * the facet key adds `none` and a shared helper that silently widened it would
 * be a helper that could return a verb its caller cannot dispatch.
 */
export interface ActivationChoice<A extends string> {
  /** What the setting says. */
  readonly action: ComputedRef<A>
  /** What will actually run, after the fallback. */
  readonly effective: ComputedRef<A>
  /** Why the two differ, or `null` when they do not. */
  readonly hint: ComputedRef<string | null>
}

const NO_PLAYLIST_HINT =
  'Open a playlist in Curate to add to it. Until then, double-clicking plays.'

export function activationChoice<A extends string>(
  action: ComputedRef<A>,
  viewedPlaylistId: MaybeRefOrGetter<number | null>,
  fallback: A
): ActivationChoice<A> {
  const stranded = computed(
    () => action.value === 'addToViewedPlaylist' && toValue(viewedPlaylistId) === null
  )

  return {
    action,
    effective: computed(() => (stranded.value ? fallback : action.value)),
    hint: computed(() => (stranded.value ? NO_PLAYLIST_HINT : null))
  }
}
