import type Database from 'better-sqlite3'
import type { RebuildCountersResult } from '@shared/stats'
import { rebuildTrackCounters } from './counters'

/**
 * Everything the IPC layer needs from the statistics engine, and nothing more.
 *
 * The same seam `PlayHistoryService` and `ListenService` draw. One method today
 * — W10-9's `query`, `summary` and `overTime` join it here, against the same
 * database handle and the same log.
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
}

export interface SqliteStatsDeps {
  db: Database.Database
}

export class SqliteStatsService implements StatsService {
  private readonly db: Database.Database

  constructor(deps: SqliteStatsDeps) {
    this.db = deps.db
  }

  async rebuildCounters(): Promise<RebuildCountersResult> {
    return rebuildTrackCounters(this.db)
  }
}
