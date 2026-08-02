import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import type { ArtistBiographyResult } from '@shared/biography'
import { artists } from '@renderer/ipc'

/**
 * The artist's biography, as the deck holds it.
 *
 * Separate from `artistIdentity` rather than a field on it, because the two
 * answer to different things. The identity is keyed on the *track* and changes
 * on every skip; the biography is keyed on the resolved *artist* and does not
 * change when the operator moves between two songs from the same album. Merging
 * them would mean either refetching a biography per track — which is the traffic
 * pattern R5's secondary risk is about, even against a cache — or bolting an
 * artist-scoped guard onto a track-scoped store.
 *
 * ## What it does not do
 *
 * No retry timer, no polling, no fetch on collapse or expand. Every failure is a
 * `NetFailure` on the result, which the pane renders as a sentence with a Retry
 * button, and `useDeckData` is the only thing that decides when to ask.
 *
 * ## Why an artist that has not resolved is `load(null)`
 *
 * Rather than an early return in the caller. The deck is a long-lived surface
 * and skipping from a resolved artist to an unresolved one has to *clear* the
 * biography — a pane still showing the last band's history under the new one's
 * name is precisely the confident-and-wrong failure R5 is about, arriving by a
 * different route.
 */
export const useArtistBiographyStore = defineStore('artistBiography', () => {
  const result = shallowRef<ArtistBiographyResult | null>(null)
  const artistId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The call itself rejected — a bug or a closed window, not a network state. */
  const failed = shallowRef(false)
  /** Whether the operator has asked for the whole thing. Resets per artist. */
  const expanded = shallowRef(false)

  /** The related store's guard: two artists in flight, and nothing orders replies. */
  let issued = 0

  const biography = computed(() => result.value?.biography ?? null)

  /** True when the lookup completed and there is simply no article. */
  const empty = computed(() => result.value?.status === 'none')

  /** The network state, if the lookup failed for one. Drives the retry. */
  const failure = computed(() => result.value?.failure ?? null)

  async function load(nextArtistId: number | null): Promise<void> {
    const request = ++issued

    if (nextArtistId === null) {
      result.value = null
      artistId.value = null
      loading.value = false
      failed.value = false
      expanded.value = false
      return
    }

    // Idempotent per artist. `useDeckData` fires on every track change, and two
    // tracks by the same artist share a biography — re-asking would be a cache
    // read in main and a flicker of the loading state here, for the same text.
    if (nextArtistId === artistId.value && result.value !== null && !failed.value) return

    // Dropped before the await, not after it. The alternative — keeping the old
    // answer until the new one lands — leaves Led Zeppelin's history on screen
    // under Nirvana's name for as long as the lookup takes, which for an artist
    // the deck has not seen before is a MusicBrainz round trip rather than a
    // frame. That is R5's confident-and-wrong failure arriving by a side door,
    // and it is also the thing that made a track change feel like a glitch.
    //
    // Guarded on the id so a `refresh` of the artist already on screen does not
    // blank the pane it is refreshing.
    if (nextArtistId !== artistId.value) result.value = null

    artistId.value = nextArtistId
    loading.value = true
    failed.value = false
    // A new artist is a new preview. Leaving this set would open the next
    // biography fully expanded because the last one was.
    expanded.value = false
    try {
      const next = await artists.biography(nextArtistId)
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

  function toggleExpanded(): void {
    expanded.value = !expanded.value
  }

  return {
    result,
    artistId,
    loading,
    failed,
    expanded,
    biography,
    empty,
    failure,
    load,
    refresh,
    toggleExpanded
  }
})
