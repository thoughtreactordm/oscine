import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import type { ArtistFavoritesResult } from '@shared/favorites'
import { favorites as ipc } from '@renderer/ipc'
import { useFavoritesStore } from '@renderer/stores/favorites'

/**
 * The playing artist's favorites, as the deck holds them — **D18**.
 *
 * `useRelatedStore`'s neighbour in every respect: one bounded answer for one
 * seed track, refreshed as the seed changes, held in a `shallowRef` because the
 * payload is capped and replaced wholesale rather than mutated.
 *
 * ## Why it follows the track and not the resolved artist
 *
 * The biography, the relations and the image are all keyed on an `artistId` and
 * are all gated on an mbid, because all three leave the machine. This one is
 * keyed on the track for the opposite reason: the only thing in the renderer
 * that holds an artist id is `artistIdentity`, and getting one from it means
 * waiting on the call that may open a socket. With lookups declined that call
 * returns at once; with the cable pulled it returns when a connection times out,
 * and a pane of purely local rows would have sat behind it showing nothing.
 * **D14**'s third rule is that a local surface keeps working with networking
 * declined, and the way to keep it is to have nothing to wait for.
 *
 * So `favorites.byArtist` takes the seed and resolves `tracks.artist_id` in
 * SQLite, and this store never learns an artist id until the answer carries one.
 * Two tracks by the same artist do re-ask, exactly as they do for relations —
 * one indexed read against a local table, on a gesture that already costs a
 * decode.
 *
 * `failed` therefore means what it means in the related store: the IPC call
 * itself rejected, which is a bug or a closing window rather than a state of the
 * world. There is no `NetFailure` here because there is no network call to fail.
 *
 * ## It follows the heart
 *
 * `useFavoritesStore` announces every change to the table, whichever surface
 * made it, and this reloads on the announcement exactly as `favoritesList`
 * does. Hearting the playing track puts it at the top of this pane without the
 * pane knowing which control was clicked.
 */
export const useArtistFavoritesStore = defineStore('artistFavorites', () => {
  const hearts = useFavoritesStore()

  const result = shallowRef<ArtistFavoritesResult | null>(null)
  const seedId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The query rejected. Distinct from "answered with nothing" — the pane says so. */
  const failed = shallowRef(false)

  /**
   * The related store's guard, and it is needed here for the same reason:
   * skipping through four tracks fires four loads and nothing orders their
   * replies. Compared against the counter rather than against `seedId`, so
   * skipping away and back does not let the older answer through on a match.
   */
  let issued = 0

  const tracks = computed(() => result.value?.tracks ?? [])

  /** The artist the answer was about, or `null` when the seed named none. */
  const artistId = computed(() => result.value?.artistId ?? null)

  /** More favorites exist than the cap allowed. The pane says `50+`, not `50`. */
  const truncated = computed(() => result.value?.truncated ?? false)

  async function load(trackId: number | null): Promise<void> {
    const request = ++issued

    if (trackId === null) {
      result.value = null
      seedId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Dropped before the await rather than after it, unlike the related store's
    // which holds nothing artist-shaped. Keeping the previous answer until the
    // new one lands would leave one band's favorites listed under another band's
    // name for as long as the query takes — briefly empty is honest, briefly
    // wrong is not.
    if (trackId !== seedId.value) result.value = null

    seedId.value = trackId
    loading.value = true
    failed.value = false
    try {
      const next = await ipc.byArtist(trackId)
      if (request !== issued) return
      result.value = next
    } catch {
      // Swallowed and surfaced as a flag, following the related store: a deck
      // pane that could throw into a track change would be a reading surface
      // with the power to interrupt playback.
      if (request !== issued) return
      result.value = null
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  /** Re-asks for the current seed. The Retry button, and every heart. */
  async function refresh(): Promise<void> {
    await load(seedId.value)
  }

  /**
   * Re-reads on any heart, anywhere — `favoritesList`'s subscription.
   *
   * Unconditional rather than filtered to tracks by this artist. Deciding
   * whether an id belongs to the artist would need the whole artist's tracks,
   * and this holds fifty of their *favorites* at most; a heart is a gesture
   * nobody makes twice a second, and one local query on it is cheaper than a
   * filter that is wrong on the fifty-first row.
   */
  watch(
    () => hearts.changed,
    (change) => {
      if (change === null) return
      if (seedId.value === null) return
      void refresh()
    }
  )

  return { result, seedId, loading, failed, tracks, artistId, truncated, load, refresh }
})
