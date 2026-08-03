import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { Track } from '@shared/library'
import { favorites } from '@renderer/ipc'

/**
 * The heart, and the one thing the renderer has to hold about it — **D18**.
 *
 * `Track.favorite` arrives with every page, resolved in the query that built it,
 * so the ordinary case needs no store at all: a row draws its own heart from its
 * own row. What a store is for is the moment *after* a click. The same track is
 * on screen in the song list, in NowPlaying and possibly in the related pane,
 * all three reading `Track` objects that came from different requests, and none
 * of them is going to re-fetch its page because one of the others was clicked.
 *
 * So this holds the toggles made since those pages were loaded, and `isFavorite`
 * is the reconciliation: the override if there is one, the row's own value
 * otherwise. A page loaded *after* a toggle carries the same answer the override
 * does, so the two can never disagree — which is why nothing here has to expire.
 *
 * It grows by one entry per heart the operator clicks, which is a bound set by
 * how fast a person can click and not by the size of the library.
 *
 * No push event from main, following `playHistory`: every state change here is
 * one this renderer asked for. A second window would need the broadcast, and
 * inventing the channel now would be inventing the reconciliation too.
 */
export const useFavoritesStore = defineStore('favorites', () => {
  /**
   * Toggles made this session, by track id.
   *
   * A reactive `Map` rather than a `shallowRef` over an immutable one: reads are
   * per-row inside a virtualized render effect, and Vue tracks `Map.get` at the
   * key, so a heart repaints without every other row in the list re-rendering.
   */
  const overrides = ref(new Map<number, boolean>())

  /** The tracks a toggle is in flight for. A second click on one is ignored. */
  const pending = shallowRef<ReadonlySet<number>>(new Set())

  /**
   * Whether this track is favorited, as the renderer currently knows it.
   *
   * Takes the whole `Track` rather than an id because the row's own value is the
   * fallback, and there is nowhere else to get it — a caller with only an id has
   * no baseline to fall back to and wants `favorites.state` instead.
   */
  function isFavorite(track: Track): boolean {
    return overrides.value.get(track.id) ?? track.favorite
  }

  function isPending(trackId: number): boolean {
    return pending.value.has(trackId)
  }

  /**
   * Flips one track's heart and records what main says resulted.
   *
   * Deliberately not optimistic. The write is one local SQLite statement behind
   * one IPC round trip — fast enough that a filled heart appearing a frame later
   * reads as instant, and slow enough that painting the wrong state first and
   * correcting it would be visible as a flicker on the failure path. Main read
   * the table; main says what it says.
   *
   * Never rejects. A heart that could throw into whatever called it is a
   * decoration with the power to break a track change; a failed toggle costs the
   * click and nothing else.
   */
  async function toggle(trackId: number): Promise<void> {
    if (pending.value.has(trackId)) return
    pending.value = new Set(pending.value).add(trackId)
    try {
      const state = await favorites.toggle(trackId)
      overrides.value.set(state.trackId, state.favorite)
    } catch {
      // Deliberately silent. See above.
    } finally {
      const next = new Set(pending.value)
      next.delete(trackId)
      pending.value = next
    }
  }

  return { overrides, isFavorite, isPending, toggle }
})
