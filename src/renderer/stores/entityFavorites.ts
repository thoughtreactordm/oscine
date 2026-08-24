import { ref, shallowRef } from 'vue'

/**
 * The two channels a per-entity star rides on — **D24**.
 *
 * `toggle` flips one id and answers with the favorited subset of the ids it
 * touched (a set of one), and `state` is the batch lookup a list hydrates
 * through. Both return `EntityFavoriteStateResult`, so the star reads its own
 * state off the answer rather than predicting the outcome of its own click.
 */
interface EntityFavoriteChannels {
  readonly toggle: (id: number) => Promise<{ favoritedIds: number[] }>
  readonly state: (ids: readonly number[]) => Promise<{ favoritedIds: number[] }>
}

/**
 * The star's store, shared by playlists and artists — **D24**, product rule 6.
 *
 * The playlist and artist stars are the same store with two different channels:
 * a favorited-by-id map, a batch hydrate for a list, and an **optimistic**
 * toggle. Factored rather than written twice because the only thing that differs
 * between `usePlaylistFavorites` and `useArtistFavorites` is which pair of IPC
 * calls they hand in — everything a star does with the answer is identical.
 *
 * ## Why optimistic, where the heart is not
 *
 * The track heart (`favorites.ts`) deliberately waits for main and paints no
 * guess, because two views of the same track can disagree about what they had
 * and a wrong first paint reads as a flicker. A star has neither problem: it is
 * one control on one header for one entity, so there is no second view to
 * disagree with, and painting the outcome now is what makes it feel like a
 * toggle rather than a request. Main's answer still lands and still wins — the
 * optimistic value is corrected to it, and reverted on a rejection — so a
 * failed write costs the paint and nothing else.
 *
 * There is no push channel and no `changed` event, following the heart: every
 * state here is one this store asked for, and the entity lists are short views
 * recomputed on open (D26) rather than standing subscriptions.
 */
export function createEntityFavorites(channels: EntityFavoriteChannels) {
  /**
   * Favorited-ness by entity id, as this store currently knows it.
   *
   * A reactive `Map` for `favorites.ts`' reason: a star reads its own key inside
   * whatever renders it, and Vue tracks `Map.get` at the key, so one star
   * repaints without disturbing the others hydrated alongside it.
   */
  const favorited = ref(new Map<number, boolean>())

  /** The ids a toggle is in flight for. A second click on one is dropped. */
  const pending = shallowRef<ReadonlySet<number>>(new Set())

  /** Whether this entity is starred. Unknown ids read as not — nothing hydrated says so. */
  function isFavorite(id: number): boolean {
    return favorited.value.get(id) ?? false
  }

  function isPending(id: number): boolean {
    return pending.value.has(id)
  }

  /**
   * Fills in the stars for a set of ids from one batch read.
   *
   * Every requested id is written — present in the answer means starred, absent
   * means not — so a list draws every star from one round trip. An id with a
   * toggle in flight is skipped: its optimistic value is newer than any batch
   * this read could carry, and letting a stale answer clobber it would flicker
   * the star the operator just clicked.
   */
  async function hydrate(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) return
    const { favoritedIds } = await channels.state(ids)
    const set = new Set(favoritedIds)
    for (const id of ids) {
      if (pending.value.has(id)) continue
      favorited.value.set(id, set.has(id))
    }
  }

  /**
   * Flips one entity's star, optimistically.
   *
   * Paints the opposite of what it held before the round trip, reconciles to
   * whatever main says resulted, and reverts to the prior value on a rejection —
   * a star that could throw into whatever rendered it would be a decoration with
   * the power to break a header.
   */
  async function toggle(id: number): Promise<void> {
    if (pending.value.has(id)) return
    const previous = favorited.value.get(id) ?? false
    favorited.value.set(id, !previous)
    pending.value = new Set(pending.value).add(id)
    try {
      const { favoritedIds } = await channels.toggle(id)
      favorited.value.set(id, favoritedIds.includes(id))
    } catch {
      favorited.value.set(id, previous)
    } finally {
      const next = new Set(pending.value)
      next.delete(id)
      pending.value = next
    }
  }

  return { favorited, isFavorite, isPending, hydrate, toggle }
}
