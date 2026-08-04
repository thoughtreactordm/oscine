import type Database from 'better-sqlite3'
import { PLAY_HISTORY_CAP, type ListPlayHistoryQuery, type PlayEntry } from '@shared/history'
import { PlayHistoryStore } from './store'

/**
 * Everything the IPC layer needs from the play-history trail, and nothing more.
 *
 * The same seam `LibraryService` and `PlaylistService` draw, for the same
 * reason: the handlers validate and delegate, and never learn that eviction is
 * a rowid range. Async because the boundary is, not because the store is.
 */
export interface PlayHistoryService {
  /**
   * Records one play, stamped in main.
   *
   * Main owns the clock rather than accepting a timestamp from the renderer.
   * The trail is ordered by row id and displayed by `playedAt`, and a renderer
   * that could set the second could make a row *say* it happened at a time the
   * order contradicts.
   *
   * Resolves `null` when the track is no longer in the library.
   */
  record(trackId: number): Promise<PlayEntry | null>
  list(query: ListPlayHistoryQuery): Promise<PlayEntry[]>
  clear(): Promise<void>
}

export interface SqlitePlayHistoryDeps {
  db: Database.Database
  /** Injectable so a test can assert an order without racing the clock. */
  now?: () => number
  /** Overridable so a test can reach the cap without five hundred inserts. */
  cap?: number
  /**
   * Told after a play was recorded — the transport-commit moment, in main.
   *
   * A notification that a play started, not a scrobbling hook: this service
   * knows about a trail and must not learn what Last.fm is. `main/index.ts`
   * joins it to D19's now-playing announcer, which is the one place that
   * knows both (W11-5).
   *
   * Called only when a row was actually written, and never awaited.
   */
  onRecorded?: (entry: PlayEntry) => void
}

export class SqlitePlayHistoryService implements PlayHistoryService {
  private readonly store: PlayHistoryStore
  private readonly now: () => number
  private readonly cap: number
  private readonly onRecorded: ((entry: PlayEntry) => void) | null

  constructor(deps: SqlitePlayHistoryDeps) {
    this.cap = Math.max(1, deps.cap ?? PLAY_HISTORY_CAP)
    this.store = new PlayHistoryStore(deps.db, this.cap)
    this.now = deps.now ?? Date.now
    this.onRecorded = deps.onRecorded ?? null
  }

  async record(trackId: number): Promise<PlayEntry | null> {
    const entry = this.store.record(trackId, this.now())
    // Only for a track still in the library. `null` means there was no play to
    // announce, and announcing one would be claiming to play a track that has
    // just left.
    if (entry !== null) this.onRecorded?.(entry)
    return entry
  }

  /**
   * The trail, most recent first.
   *
   * Clamped to the cap rather than to a page ceiling of its own, because the
   * cap already bounds the table: there is no request this can serve that the
   * store could not have been asked for outright, and no page two to invent.
   */
  async list(query: ListPlayHistoryQuery): Promise<PlayEntry[]> {
    const limit = Math.min(Math.max(0, Math.trunc(query.limit)), this.cap)
    if (limit === 0) return []
    return this.store.list(limit)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }
}
