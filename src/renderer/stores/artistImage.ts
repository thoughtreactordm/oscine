import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import type { ArtistImageResult } from '@shared/artistImage'
import { artists } from '@renderer/ipc'

/**
 * The artist's photograph, as the deck holds it.
 *
 * Separate from `artistBiography` for the same reason that one is separate from
 * `artistIdentity`: they answer to the same trigger and fail independently. A
 * Commons outage must leave the biography on screen, and a Wikipedia outage must
 * leave the picture there — which is only true if neither is a field on the
 * other.
 *
 * ## Why a missing picture is not worth a word
 *
 * The biography renders its `none` as an empty state, because an operator who
 * opened the Biography group asked a question and deserves an answer. Nobody
 * asks for the backdrop. It is the header's surface, and when there is no
 * photograph the header falls back to the blurred cover art it would have shown
 * anyway — so `none` here is silence, not a sentence. `failure` is exposed all
 * the same, because the *identity* header above it already has a retry
 * affordance and a picture that failed for a network reason is worth retrying
 * along with everything else.
 *
 * ## Why the whole result is dropped on an artist change
 *
 * `artistBiography` gives the argument and it applies with more force to an
 * image: a photograph of the wrong band under the right band's name is R5's
 * confident-and-wrong failure with no text to give it away.
 */
export const useArtistImageStore = defineStore('artistImage', () => {
  const result = shallowRef<ArtistImageResult | null>(null)
  const artistId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The call itself rejected — a bug or a closed window, not a network state. */
  const failed = shallowRef(false)

  /** The sibling stores' guard: two artists in flight, and nothing orders replies. */
  let issued = 0

  const image = computed(() => result.value?.image ?? null)

  /** The network state, if the lookup failed for one. */
  const failure = computed(() => result.value?.failure ?? null)

  async function load(nextArtistId: number | null): Promise<void> {
    const request = ++issued

    if (nextArtistId === null) {
      result.value = null
      artistId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Idempotent per artist, for `artistBiography.load`'s reason. Two tracks by
    // the same artist share a photograph, and re-asking would be a cache read
    // in main and a flicker of the backdrop here for the same picture.
    if (nextArtistId === artistId.value && result.value !== null && !failed.value) return

    if (nextArtistId !== artistId.value) result.value = null

    artistId.value = nextArtistId
    loading.value = true
    failed.value = false
    try {
      const next = await artists.image(nextArtistId)
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

  /** Re-asks for the current artist, on the header's retry. */
  async function refresh(): Promise<void> {
    const current = artistId.value
    // Cleared first, so `load`'s idempotence guard does not swallow the retry it
    // exists to make possible.
    result.value = null
    failed.value = false
    await load(current)
  }

  return { result, artistId, loading, failed, image, failure, load, refresh }
})
