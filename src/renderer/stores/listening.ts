import { defineStore } from 'pinia'
import { computed, shallowRef, watch } from 'vue'
import { stats as ipc } from '@renderer/ipc'
import {
  LISTENING_RANGE_KEY,
  LISTENING_SORT_KEY,
  rangeFor,
  resolveRangeId,
  resolveSort,
  seriesFor,
  type ListeningRangeId
} from '@renderer/panels/listening/listeningRange'
import { useViewSettings } from '@renderer/settings'
import {
  ALL_TIME,
  STATS_DIMENSIONS,
  type StatsDimension,
  type StatsOverTimeResult,
  type StatsQueryResult,
  type StatsSort,
  type StatsSummary
} from '@shared/stats'

/** The four rankings for one range, keyed by what each groups on. */
export type Rankings = Readonly<Record<StatsDimension, StatsQueryResult>>

/**
 * How many rows one ranked list carries.
 *
 * Well below `MAX_STATS_ROWS`, and the ceiling is not what sets it: the query
 * costs the same either way — it is a `GROUP BY` over the range whichever
 * `LIMIT` follows it — so this is a question about the list and not about
 * SQLite. Fifty is more than a screen, which is what makes the list worth
 * virtualizing and worth scrolling; past that a top list is answering a
 * question the dashboard is not asking, and `total` says how much was left
 * out. A caller wanting the whole distribution wants W10-14.
 */
export const TOP_LIST_LIMIT = 50

/**
 * What the Listening dashboard is showing — **D17**, read rather than written.
 *
 * One range, one sort, and the six answers they produce: the headline summary,
 * four rankings and a series. Everything here is local; nothing in this store
 * can reach the network, and the dashboard draws with the cable pulled.
 *
 * ## Two round trips, deliberately
 *
 * The summary and the four rankings go together, so the five share one round
 * trip's latency. The series follows them rather than joining them, because
 * under "all time" its left edge *is* `summary.firstListenAt` — see
 * `seriesFor`. Issuing it in the same batch would mean two shapes of load, one
 * for the bounded presets and one for all-time, and one code path is worth
 * more than one round trip: measured, the ordinary case is thirty days out of
 * four years at about a millisecond a query.
 *
 * ## The previous answer stays on screen
 *
 * A reload does not blank what is there. The range selector already shows which
 * window was asked for, so a held-and-dimmed frame reads as "these numbers are
 * catching up" while a blank one reads as a panel that broke — and on all-time
 * over a large log the gap is long enough to see. The view dims; the store just
 * declines to clear.
 *
 * A rejection is the exception and does clear, for `trackStats`' reason: the
 * numbers are captioned by a range, and holding the last range's under the new
 * one's label is briefly wrong rather than briefly blank.
 *
 * ## What it does not follow
 *
 * Nothing invalidates this on a listen. A listen commits when a track departs,
 * so a dashboard left open goes stale by one row per track — and the fix for
 * that is the Refresh the header already carries, not a reading surface
 * subscribing to the write path.
 */
export const useListeningStore = defineStore('listening', () => {
  const view = useViewSettings()
  const storedRange = view.value<string>(LISTENING_RANGE_KEY)
  const storedSort = view.value<string>(LISTENING_SORT_KEY)

  /**
   * The two controls, resolved on read.
   *
   * Writable computeds over the stored strings rather than refs mirrored into
   * them: a stored id this build has never heard of resolves forward to the
   * default on every read, so there is no moment where the view holds one value
   * and storage another.
   */
  const rangeId = computed<ListeningRangeId>({
    get: () => resolveRangeId(storedRange.value),
    set: (id) => {
      storedRange.value = id
    }
  })

  const sort = computed<StatsSort>({
    get: () => resolveSort(storedSort.value),
    set: (value) => {
      storedSort.value = value
    }
  })

  const summary = shallowRef<StatsSummary | null>(null)
  const rankings = shallowRef<Rankings | null>(null)
  const series = shallowRef<StatsOverTimeResult | null>(null)
  const loading = shallowRef(false)
  /** The queries rejected. Distinct from "answered with nothing", which the empty state says. */
  const failed = shallowRef(false)

  /**
   * Whether the log is empty *everywhere*, not merely in this window.
   *
   * Two empties that look identical on screen and are not the same fact. "You
   * have not played anything in thirty days" is a quiet month and the useful
   * next move is a wider window; "you have not played anything" is a new library
   * and there is no window that helps. Telling them apart is what stops a
   * first-run dashboard sending someone to an All time that is just as blank —
   * which is exactly what it did before this flag existed.
   *
   * One extra query, and only ever in the case that needs it: a range that came
   * back with something has already answered the question.
   */
  const logEmpty = shallowRef(false)

  let issued = 0

  /** `true` once an answer has arrived for some range, whatever it held. */
  const answered = computed(() => summary.value !== null)

  function ranking(dimension: StatsDimension): StatsQueryResult | null {
    return rankings.value?.[dimension] ?? null
  }

  async function load(): Promise<void> {
    const request = ++issued
    const id = rangeId.value
    const activeSort = sort.value
    const now = Date.now()
    const range = rangeFor(id, now)

    loading.value = true
    failed.value = false

    try {
      const [headline, ...ranked] = await Promise.all([
        ipc.summary({ range, scope: null }),
        ...STATS_DIMENSIONS.map((dimension) =>
          ipc.query({ range, dimension, sort: activeSort, limit: TOP_LIST_LIMIT, offset: 0 })
        )
      ])

      const seriesQuery = seriesFor(id, range, headline.firstListenAt, now)
      const points = seriesQuery === null ? null : await ipc.overTime(seriesQuery)
      const nothingAnywhere =
        headline.listens > 0
          ? false
          : id === 'all' || (await ipc.summary({ range: ALL_TIME, scope: null })).listens === 0

      // One commit at the end, after every await. A dashboard that painted its
      // totals and then its chart a beat later would show, for that beat, a
      // headline for one range beside a graph of the last one.
      if (request !== issued) return
      summary.value = headline
      rankings.value = Object.fromEntries(
        STATS_DIMENSIONS.map((dimension, index) => [dimension, ranked[index]])
      ) as Rankings
      series.value = points
      logEmpty.value = nothingAnywhere
    } catch {
      if (request !== issued) return
      summary.value = null
      rankings.value = null
      series.value = null
      logEmpty.value = false
      failed.value = true
    } finally {
      if (request === issued) loading.value = false
    }
  }

  // Either control changing is a new question, and the older answer's reply is
  // dropped by the counter rather than by a comparison against the controls —
  // switching away and back would otherwise let a stale reply through on a match.
  watch([rangeId, sort], () => void load())

  return {
    rangeId,
    sort,
    summary,
    rankings,
    series,
    loading,
    failed,
    logEmpty,
    answered,
    ranking,
    load
  }
})
