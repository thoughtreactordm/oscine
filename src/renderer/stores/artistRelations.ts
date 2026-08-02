import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import type { ArtistRelationsResult } from '@shared/artistRelations'
import { artists } from '@renderer/ipc'

/**
 * The artist's relation graph, as the deck holds it.
 *
 * A sibling of `artistBiography` rather than a field on it, and deliberately
 * shaped the same way down to the guard counter: both are keyed on the resolved
 * *artist* while the identity above them is keyed on the *track*, both are
 * loaded by `useDeckData` and by nothing else, and both must clear rather than
 * linger when the artist moves out from under them. Two stores with one shape is
 * the price of the two lookups being independent — a Wikipedia outage must not
 * blank the relations, and an artist with no article can still have a band.
 *
 * ## What it does not do
 *
 * No retry timer, no polling, no refetch on expanding a row. Every failure is a
 * `NetFailure` on the result, which the pane renders as a sentence with a Retry
 * button.
 *
 * ## Why the ownership half is never cached here
 *
 * The result carries which relations the library holds, and that answer expires
 * the moment a scan finishes. Holding it in the renderer past the artist it was
 * fetched for would mean a pane claiming you own three albums by a band whose
 * folder you have since removed. Main recomputes the intersection on every call
 * for the same reason; this store's job is only to make sure the call is made
 * about the right artist.
 */
export const useArtistRelationsStore = defineStore('artistRelations', () => {
  const result = shallowRef<ArtistRelationsResult | null>(null)
  const artistId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The call itself rejected — a bug or a closed window, not a network state. */
  const failed = shallowRef(false)

  /** Two artists in flight, and nothing orders replies. */
  let issued = 0

  const relations = computed(() => result.value?.relations ?? [])

  /** True when the lookup completed and MusicBrainz records no connections. */
  const empty = computed(() => result.value?.status === 'none')

  /** The network state, if the lookup failed for one. Drives the retry. */
  const failure = computed(() => result.value?.failure ?? null)

  /** How many of these the library already holds. The group's badge. */
  const ownedCount = computed(
    () => relations.value.filter((relation) => relation.match !== null).length
  )

  async function load(nextArtistId: number | null): Promise<void> {
    const request = ++issued

    if (nextArtistId === null) {
      result.value = null
      artistId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Idempotent per artist, for the biography store's reason: `useDeckData`
    // fires on every track change and two tracks by the same artist share a
    // relation graph.
    if (nextArtistId === artistId.value && result.value !== null && !failed.value) return

    // Dropped before the await, guarded on the id so a `refresh` of the artist
    // already on screen does not blank the pane it is refreshing. Keeping the
    // old answer across a change of artist would put one band's members under
    // another band's name, which is the failure this whole tab is built to
    // avoid.
    if (nextArtistId !== artistId.value) result.value = null

    artistId.value = nextArtistId
    loading.value = true
    failed.value = false
    try {
      const next = await artists.relations(nextArtistId)
      if (request !== issued) return
      result.value = next
    } catch {
      if (request !== issued) return
      result.value = null
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  /** Re-asks for the current artist. The Retry button. */
  async function refresh(): Promise<void> {
    const current = artistId.value
    // Cleared first, so `load`'s idempotence guard does not swallow the retry it
    // exists to make possible.
    result.value = null
    failed.value = false
    await load(current)
  }

  return {
    result,
    artistId,
    loading,
    failed,
    relations,
    empty,
    failure,
    ownedCount,
    load,
    refresh
  }
})
