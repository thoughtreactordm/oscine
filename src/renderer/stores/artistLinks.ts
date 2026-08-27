import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import type { ArtistLinksResult } from '@shared/artistLinks'
import { artists } from '@renderer/ipc'

/**
 * The artist's outbound links, as the deck holds it.
 *
 * A sibling of `artistBiography` and `artistRelations`, shaped the same way down
 * to the guard counter: keyed on the resolved *artist* while the identity above
 * it is keyed on the *track*, loaded by `useDeckData` and by nothing else, and
 * cleared rather than left to linger when the artist moves out from under it.
 * Three stores with one shape is the price of the three lookups being
 * independent — a MusicBrainz outage on one document must not blank the other.
 *
 * Unlike `artistRelations` there is no library half here: the links are the whole
 * answer, so this store caches the result plainly. It still clears on a change of
 * artist for the same reason its siblings do — a homepage row that outlived its
 * artist is a link to the wrong front door.
 *
 * ## What it does not do
 *
 * No retry timer, no polling. Every failure is a `NetFailure` on the result,
 * which the pane renders as a sentence with a Retry button.
 */
export const useArtistLinksStore = defineStore('artistLinks', () => {
  const result = shallowRef<ArtistLinksResult | null>(null)
  const artistId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The call itself rejected — a bug or a closed window, not a network state. */
  const failed = shallowRef(false)

  /** Two artists in flight, and nothing orders replies. */
  let issued = 0

  const links = computed(() => result.value?.links ?? [])

  /** True when the lookup completed and MusicBrainz records no links. */
  const empty = computed(() => result.value?.status === 'none')

  /** The network state, if the lookup failed for one. Drives the retry. */
  const failure = computed(() => result.value?.failure ?? null)

  /** How many links there are. The group's badge. */
  const count = computed(() => links.value.length)

  async function load(nextArtistId: number | null): Promise<void> {
    const request = ++issued

    if (nextArtistId === null) {
      result.value = null
      artistId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Idempotent per artist, for the relations store's reason: `useDeckData`
    // fires on every track change and two tracks by the same artist share one
    // set of links.
    if (nextArtistId === artistId.value && result.value !== null && !failed.value) return

    // Dropped before the await, guarded on the id so a `refresh` of the artist
    // already on screen does not blank the pane it is refreshing. Keeping the
    // old answer across a change of artist would offer one artist's homepage
    // under another's name.
    if (nextArtistId !== artistId.value) result.value = null

    artistId.value = nextArtistId
    loading.value = true
    failed.value = false
    try {
      const next = await artists.links(nextArtistId)
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
    links,
    empty,
    failure,
    count,
    load,
    refresh
  }
})
