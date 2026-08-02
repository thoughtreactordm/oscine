import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import { MAX_TRACK_PAGE, type Track } from '@shared/library'
import type { RelatedResult } from '@shared/related'
import { library } from '@renderer/ipc'

/**
 * Relations for one seed track, refreshed as the seed changes.
 *
 * A store rather than pane state because the seed is the transport's, not the
 * pane's: the deck can be closed and reopened mid-track, and re-querying six
 * strands because a disclosure triangle moved is work for nothing. The pane
 * asks for a seed and reads what comes back.
 *
 * `shallowRef` over the result, following the trail and up-next stores. The
 * payload is capped by `RELATED_SECTION_LIMIT` per section and every object in
 * it is replaced wholesale on refresh, so deep-proxying a few hundred immutable
 * rows would be reactivity nobody reads.
 */
export const useRelatedStore = defineStore('related', () => {
  const result = shallowRef<RelatedResult | null>(null)
  const seedId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The query rejected. Distinct from "answered with nothing" — the pane says so. */
  const failed = shallowRef(false)

  /**
   * Monotonic, and the only thing standing between this store and a stale
   * answer overwriting a fresh one.
   *
   * Track changes can outrun a query: skipping through four tracks fires four
   * loads, and nothing guarantees they resolve in order. Without the guard the
   * pane settles on whichever finished last, which on a slow first query is the
   * track the operator has already left. Comparing against the counter rather
   * than against `seedId` also covers the case where the operator skips away
   * and back — the ids match, but the older response is still the wrong one.
   */
  let issued = 0

  async function load(trackId: number | null): Promise<void> {
    const request = ++issued

    if (trackId === null) {
      result.value = null
      seedId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Not an early return on an unchanged id: a rescan can change what a track
    // relates to without changing which track it is, and `refresh` exists to
    // ask again. The pane simply does not call this when nothing moved.
    seedId.value = trackId
    loading.value = true
    failed.value = false
    try {
      const next = await library.getRelated(trackId)
      if (request !== issued) return
      result.value = next
    } catch {
      if (request !== issued) return
      // Deliberately swallowed and surfaced as a flag. A related pane that
      // could throw into a track change would be a discovery feature with the
      // power to interrupt playback, which is the same argument the trail store
      // makes about `record`.
      result.value = null
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  /** Re-asks for the current seed. For a rescan, or a manual retry after a failure. */
  async function refresh(): Promise<void> {
    await load(seedId.value)
  }

  /**
   * Every track on an album, in album order.
   *
   * Lives here rather than in the pane because it is an IPC call, and it uses
   * the ordinary track query rather than a bespoke channel: `albumIds` is an
   * existing browse filter and `trackNo` is an existing sort, so an album's
   * contents cost no new main-process surface at all.
   */
  async function albumTracks(albumId: number): Promise<Track[]> {
    const page = await library.listTracks({
      albumIds: [albumId],
      sort: 'trackNo',
      direction: 'asc',
      offset: 0,
      limit: MAX_TRACK_PAGE
    })
    return page.tracks
  }

  return { result, seedId, loading, failed, load, refresh, albumTracks }
})
