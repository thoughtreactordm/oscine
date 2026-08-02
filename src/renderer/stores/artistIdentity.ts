import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import type { ArtistResolution } from '@shared/artist'
import { artists } from '@renderer/ipc'

/**
 * Who is playing, as an identity — **R5**'s state in the renderer.
 *
 * A store rather than pane state for the related store's reason: the seed is the
 * transport's, the deck can be closed and reopened mid-track, and the header
 * that shows the identity is drawn above a group that may be shut. It is also
 * the only place in the renderer that can cause main to open a socket, which is
 * a good reason for there to be exactly one of it.
 *
 * ## Two loading flags, not one
 *
 * `loading` is the automatic resolution and `searching` is the picker's own
 * request. They are separate because they are separately visible and separately
 * cancellable-looking: a spinner in the header while the picker is fetching
 * would say the identity is being recomputed, which is precisely what
 * `searchCandidates` promises not to do.
 *
 * ## What is deliberately absent
 *
 * No retry timer, no polling, no refresh-on-focus. Every failure here is a
 * `NetFailure` on the resolution, which the header renders as a sentence with a
 * Retry button attached. R5's secondary risk is a shuffle-heavy session
 * saturating MusicBrainz, and the way a store contributes to that is by asking
 * again on its own initiative.
 */
export const useArtistIdentityStore = defineStore('artistIdentity', () => {
  const resolution = shallowRef<ArtistResolution | null>(null)
  const seedId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The call itself rejected — a bug or a closed window, not a network state. */
  const failed = shallowRef(false)

  const pickerOpen = shallowRef(false)
  const searching = shallowRef(false)

  /**
   * The same guard the related store carries, for the same reason: skipping
   * through four tracks fires four resolutions and nothing orders their
   * replies. Compared against a counter rather than against `seedId`, so
   * skipping away and back does not let the older answer through on a match of
   * ids.
   */
  let issued = 0

  /** True once there is an accepted MusicBrainz identity to show. */
  const resolved = computed(() => resolution.value?.status === 'resolved')

  /** Whether the operator has overruled us. Drives the "your choice" wording. */
  const corrected = computed(() => resolution.value?.source === 'manual')

  async function load(trackId: number | null): Promise<void> {
    const request = ++issued

    if (trackId === null) {
      resolution.value = null
      seedId.value = null
      loading.value = false
      failed.value = false
      pickerOpen.value = false
      return
    }

    seedId.value = trackId
    loading.value = true
    failed.value = false
    // A track change while the picker is open is the operator having moved on
    // from the artist they were correcting. Leaving it open would apply the next
    // click to a list belonging to the previous track.
    pickerOpen.value = false
    try {
      const next = await artists.resolve(trackId)
      if (request !== issued) return
      resolution.value = next
    } catch {
      // Swallowed and surfaced as a flag, like the related store's: an artist
      // lookup that could throw into a track change would be a decoration with
      // the power to interrupt playback.
      if (request !== issued) return
      resolution.value = null
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  /** Re-asks for the current seed. The Retry button, and a post-rescan refresh. */
  async function refresh(): Promise<void> {
    await load(seedId.value)
  }

  /**
   * Opens the picker, fetching the alternatives.
   *
   * The list is requested here rather than kept warm, because an identity that
   * is already settled should cost no request until somebody disagrees with it.
   * Whatever `resolve` happened to have cached is already on screen while this
   * runs, so the picker opens populated and then fills in.
   */
  async function openPicker(): Promise<void> {
    const artistId = resolution.value?.artistId
    if (artistId === undefined) return

    pickerOpen.value = true
    searching.value = true
    const request = issued
    try {
      const next = await artists.searchCandidates(artistId)
      if (request !== issued) return
      resolution.value = next
    } catch {
      if (request !== issued) return
      failed.value = true
    } finally {
      if (request === issued) searching.value = false
    }
  }

  function closePicker(): void {
    pickerOpen.value = false
  }

  /**
   * Records the operator's choice. `null` is "none of these".
   *
   * The picker closes on success and stays open on failure, because a failure
   * here means the choice was not stored and closing would look like it was.
   */
  async function choose(mbid: string | null): Promise<void> {
    const artistId = resolution.value?.artistId
    if (artistId === undefined) return

    const request = issued
    try {
      const next = await artists.setMbid(artistId, mbid)
      if (request !== issued) return
      resolution.value = next
      pickerOpen.value = false
    } catch {
      if (request === issued) failed.value = true
    }
  }

  /** Drops the correction and lets the matcher decide again. */
  async function matchAutomatically(): Promise<void> {
    const artistId = resolution.value?.artistId
    if (artistId === undefined) return

    const request = issued
    searching.value = true
    try {
      const next = await artists.clearMbid(artistId)
      if (request !== issued) return
      resolution.value = next
      pickerOpen.value = false
    } catch {
      if (request === issued) failed.value = true
    } finally {
      if (request === issued) searching.value = false
    }
  }

  return {
    resolution,
    seedId,
    loading,
    failed,
    pickerOpen,
    searching,
    resolved,
    corrected,
    load,
    refresh,
    openPicker,
    closePicker,
    choose,
    matchAutomatically
  }
})
