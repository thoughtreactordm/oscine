import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'
import { ALL_TIME, STATS_SCOPE_BYS, type StatsScopeBy, type StatsSummary } from '@shared/stats'
import { stats as ipc } from '@renderer/ipc'

/** The three summaries for one seed, keyed by what each is scoped to. */
export type ScopedSummaries = Readonly<Record<StatsScopeBy, StatsSummary>>

/**
 * What the playing track, its album and its artist add up to — **D17**.
 *
 * `useArtistFavoritesStore`'s neighbour in shape and for the same reasons: one
 * bounded answer per seed track, replaced wholesale as the seed changes, held in
 * a `shallowRef` because nothing mutates it in place. The guard against a reply
 * that outran a track change is the same counter, compared against itself rather
 * than against `seedId`, so skipping away and back does not let the older answer
 * through on a match.
 *
 * ## Local, and three calls rather than one
 *
 * Nothing here leaves the machine. Three scopes are three `stats.summary` calls
 * because a summary answers about one group and these are three different
 * groups — but they are issued together and awaited together, so the deck pays
 * one round trip's latency and not three. Measured at four years and a hundred
 * thousand listens the three cost about 50 ms of SQLite between them, which is
 * why this is a query per track change and not a cache with an invalidation
 * problem. See `tests/main/stats/statsScale.test.ts`.
 *
 * A rejection collapses all three: they are one answer to the operator, and a
 * pane showing two numbers and one error would be reporting a transport failure
 * as if it were a fact about their listening.
 *
 * ## What it does not follow
 *
 * A listen commits when a track *departs*, which is the same moment the deck's
 * seed becomes the next track. So the count shown for a track while it plays
 * excludes the play in progress — correctly, because that play has not qualified
 * yet — and the artist total for a following track by the same artist may be one
 * behind for as long as it takes the insert to land. It corrects itself on the
 * next track change, and the alternative is the deck subscribing to the write
 * path, which would make a reading surface a participant in the listen commit.
 */
export const useTrackStatsStore = defineStore('trackStats', () => {
  const result = shallowRef<ScopedSummaries | null>(null)
  const seedId = shallowRef<number | null>(null)
  const loading = shallowRef(false)
  /** The queries rejected. Distinct from "answered with zero" — the pane says so. */
  const failed = shallowRef(false)

  let issued = 0

  /** `true` once an answer has arrived for the current seed, whatever it held. */
  const answered = computed(() => result.value !== null)

  function summary(by: StatsScopeBy): StatsSummary | null {
    return result.value?.[by] ?? null
  }

  async function load(trackId: number | null): Promise<void> {
    const request = ++issued

    if (trackId === null) {
      result.value = null
      seedId.value = null
      loading.value = false
      failed.value = false
      return
    }

    // Dropped before the await, following `useArtistFavoritesStore`: these
    // numbers are labelled "This track", and holding the previous track's while
    // the new one's are in flight would put a caption on the wrong music.
    // Briefly blank is honest; briefly wrong is not.
    if (trackId !== seedId.value) result.value = null

    seedId.value = trackId
    loading.value = true
    failed.value = false
    try {
      const answers = await Promise.all(
        STATS_SCOPE_BYS.map((by) =>
          ipc.summary({ range: ALL_TIME, scope: { trackId, by } }).then((value) => [by, value])
        )
      )
      if (request !== issued) return
      result.value = Object.fromEntries(answers) as ScopedSummaries
    } catch {
      // Swallowed and surfaced as a flag, following every other deck store: a
      // pane that could throw into a track change would be a reading surface
      // with the power to interrupt playback.
      if (request !== issued) return
      result.value = null
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  /** Re-asks for the current seed. The Retry button. */
  async function refresh(): Promise<void> {
    await load(seedId.value)
  }

  return { result, seedId, loading, failed, answered, summary, load, refresh }
})
