import type Database from 'better-sqlite3'
import type {
  RebuildCountersResult,
  StatsOverTimeQuery,
  StatsOverTimeResult,
  StatsQuery,
  StatsQueryResult,
  StatsSummary,
  StatsSummaryQuery
} from '@shared/stats'
import { rebuildTrackCounters } from './counters'
import { StatsStore } from './store'

/**
 * Everything the IPC layer needs from the statistics engine, and nothing more.
 *
 * The same seam `PlayHistoryService` and `ListenService` draw: one repair and
 * three reads, all against the same database handle and the same log.
 */
export interface StatsService {
  /**
   * Recomputes `tracks.play_count` and `tracks.last_played_at` from `listens`.
   *
   * Async because the boundary is, not because the store is: it is one
   * synchronous statement, and a rebuild that yielded halfway would leave the
   * table in a state no reader is expecting.
   */
  rebuildCounters(): Promise<RebuildCountersResult>
  /** One ranking: a range, a dimension, an order, a page. */
  query(request: StatsQuery): Promise<StatsQueryResult>
  /**
   * The headline numbers over the same range — the whole log, or one group.
   *
   * The scope is what the Tunedeck adds: the same seven numbers asked of the
   * listens around one track, its album or its artist. See `StatsScope` for why
   * it is a track id rather than the values it matches on.
   */
  summary(request: StatsSummaryQuery): Promise<StatsSummary>
  /** A dense bucketed series over the same range. */
  overTime(request: StatsOverTimeQuery): Promise<StatsOverTimeResult>
}

export interface SqliteStatsDeps {
  db: Database.Database
}

export class SqliteStatsService implements StatsService {
  private readonly db: Database.Database
  private readonly store: StatsStore

  constructor(deps: SqliteStatsDeps) {
    this.db = deps.db
    this.store = new StatsStore(deps.db)
  }

  async rebuildCounters(): Promise<RebuildCountersResult> {
    return rebuildTrackCounters(this.db)
  }

  // Async for the boundary's sake, synchronous underneath, and deliberately not
  // moved off the main thread. Every one of the three is a range scan over an
  // index measured in milliseconds on the fixture the tests generate; a worker
  // would cost more in handle plumbing than the query costs to run.
  async query(request: StatsQuery): Promise<StatsQueryResult> {
    return this.store.query(request)
  }

  async summary(request: StatsSummaryQuery): Promise<StatsSummary> {
    return this.store.summary(request)
  }

  async overTime(request: StatsOverTimeQuery): Promise<StatsOverTimeResult> {
    return this.store.overTime(request)
  }
}
