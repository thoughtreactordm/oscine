/**
 * The scrobble outbox — the durable half of D19's "persist first, submit
 * second".
 *
 * This module owns `scrobble_queue` (migration 012) and nothing else. It does
 * no network work, holds no target, and has no opinion about when a drain
 * should happen; that is `drain.ts`. The split is deliberate — the queue is the
 * part that must still be correct after a crash, and it is much easier to argue
 * that about a file with no `await` in it.
 *
 * Every method here is synchronous, because better-sqlite3 is, which means a
 * caller can enqueue inside the same transaction as its `listens` insert
 * (W11-5) without the transaction being held open across a promise. That is the
 * whole reason the listen and its scrobble cannot get out of step.
 */

import type Database from 'better-sqlite3'
import type {
  ScrobblePayload,
  ScrobbleTargetCapabilities,
  ScrobbleTargetId
} from '@shared/scrobble'

/**
 * What a queued row is asking to have done.
 *
 * `love` and `unlove` ride in the same table as scrobbles so that they inherit
 * persistence, ordering and backoff rather than growing a second retry path
 * that is wrong in its own way (W11-6).
 */
export const SCROBBLE_QUEUE_KINDS = ['scrobble', 'love', 'unlove'] as const

export type ScrobbleQueueKind = (typeof SCROBBLE_QUEUE_KINDS)[number]

/** What a caller hands the outbox. Ids and scheduling are the outbox's job. */
export interface ScrobbleQueueEntry {
  readonly target: ScrobbleTargetId
  readonly kind: ScrobbleQueueKind
  /** Provenance only — no foreign key, and the row outlives both (migration 012). */
  readonly listenId: number | null
  readonly trackId: number | null
  readonly payload: ScrobblePayload
}

/** A row as the drain worker sees it. */
export interface ScrobbleQueueRow extends ScrobbleQueueEntry {
  readonly id: number
  readonly attempts: number
  /** UTC ms. Rows are due when this is at or before now. */
  readonly nextAttemptAt: number
  readonly lastError: string | null
}

/** One row's new due time, computed by the caller so backoff stays pure. */
export interface ScrobbleQueueReschedule {
  readonly id: number
  /** UTC ms. */
  readonly nextAttemptAt: number
}

export interface ReadyQuery {
  readonly target: ScrobbleTargetId
  /** Which kinds to take. Scrobbles batch; loves do not, so they are drained apart. */
  readonly kinds: readonly ScrobbleQueueKind[]
  readonly limit: number
  /** UTC ms. Rows due at or before this are returned. */
  readonly now: number
}

interface QueueRow {
  id: number
  target: string
  kind: string
  listen_id: number | null
  track_id: number | null
  artist_name: string
  title: string
  album_title: string | null
  album_artist_name: string | null
  duration_s: number | null
  timestamp: number
  attempts: number
  next_attempt_at: number
  last_error: string | null
}

/**
 * Why a payload can never be sent to this target, or `null` when it can.
 *
 * Pure and exported on purpose. The rule lives here so that W11-5 can ask
 * *before* opening its transaction — a listen with no artist still gets its
 * `listens` row, and an enqueue that threw inside that transaction would take
 * the listen down with it. `enqueue` asks the same question and throws, so a
 * caller that skips the check gets a loud bug rather than a row that sits in
 * the queue forever failing in a way only the service can explain.
 *
 * `capabilities` is optional because the two rules that need it — duration and
 * love support — are facts about a target, and the caller does not always have
 * one to hand (an import, a test, a repair path).
 */
export function scrobbleEnqueueRejection(
  entry: ScrobbleQueueEntry,
  capabilities?: ScrobbleTargetCapabilities
): string | null {
  const { artistName, title, durationSeconds } = entry.payload

  // Trimmed, because a tag containing one space is the same nothing as an empty
  // one to a service that indexes by artist and title.
  if (artistName.trim().length === 0) return 'The track has no artist name.'
  if (title.trim().length === 0) return 'The track has no title.'

  if (!Number.isFinite(entry.payload.timestamp) || entry.payload.timestamp <= 0) {
    return 'The listen has no usable timestamp.'
  }

  if (capabilities?.requiresDuration && durationSeconds === null) {
    return 'This service will not accept a listen with no duration.'
  }

  if (entry.kind !== 'scrobble' && capabilities && !capabilities.supportsLove) {
    return 'This service has no loves to record.'
  }

  return null
}

/** Thrown by `enqueue` for a payload `scrobbleEnqueueRejection` refuses. */
export class UnsendableScrobbleError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'UnsendableScrobbleError'
  }
}

function toRow(row: QueueRow): ScrobbleQueueRow {
  return {
    id: row.id,
    target: row.target as ScrobbleTargetId,
    kind: row.kind as ScrobbleQueueKind,
    listenId: row.listen_id,
    trackId: row.track_id,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    payload: {
      artistName: row.artist_name,
      title: row.title,
      albumTitle: row.album_title,
      albumArtistName: row.album_artist_name,
      durationSeconds: row.duration_s,
      timestamp: row.timestamp
    }
  }
}

export class ScrobbleOutbox {
  constructor(private readonly db: Database.Database) {}

  /**
   * Write one row. Returns its id.
   *
   * Deliberately not wrapped in its own transaction: W11-5 enqueues inside the
   * transaction that writes the listen, and a nested `db.transaction` there
   * would commit a savepoint that the outer rollback still has to undo. Plain
   * statements compose with whatever transaction the caller is already in.
   */
  enqueue(entry: ScrobbleQueueEntry, capabilities?: ScrobbleTargetCapabilities): number {
    const reason = scrobbleEnqueueRejection(entry, capabilities)
    if (reason !== null) throw new UnsendableScrobbleError(reason)

    const { payload } = entry
    const result = this.db
      .prepare(
        `INSERT INTO scrobble_queue (
           target, kind, listen_id, track_id,
           artist_name, title, album_title, album_artist_name,
           duration_s, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.target,
        entry.kind,
        entry.listenId,
        entry.trackId,
        payload.artistName,
        payload.title,
        payload.albumTitle,
        payload.albumArtistName,
        payload.durationSeconds,
        payload.timestamp
      )

    return Number(result.lastInsertRowid)
  }

  /**
   * The target's due rows, oldest listen first.
   *
   * `timestamp` ascending is what makes a week offline replay in the order it
   * happened rather than in the order SQLite felt like returning. `id` breaks
   * ties, which is not a detail: two loves for the same track a second apart
   * share a timestamp, and arriving as unlove-then-love instead of
   * love-then-unlove leaves the operator's account in the wrong state (W11-6).
   */
  ready(query: ReadyQuery): ScrobbleQueueRow[] {
    if (query.limit <= 0 || query.kinds.length === 0) return []

    const placeholders = query.kinds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT * FROM scrobble_queue
          WHERE target = ?
            AND kind IN (${placeholders})
            AND next_attempt_at <= ?
          ORDER BY timestamp ASC, id ASC
          LIMIT ?`
      )
      .all(query.target, ...query.kinds, query.now, query.limit) as QueueRow[]

    return rows.map(toRow)
  }

  /** Drop rows the target has finished with, accepted or refused. */
  delete(ids: readonly number[]): void {
    if (ids.length === 0) return
    const statement = this.db.prepare('DELETE FROM scrobble_queue WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) statement.run(id)
    })()
  }

  /**
   * Push rows into the future and count the attempt against them.
   *
   * `attempts` increments here and only here, so "how many times has this been
   * tried" and "when may it be tried again" can never disagree — which is what
   * lets `backoffDelayMs` be a pure function of the row.
   */
  reschedule(updates: readonly ScrobbleQueueReschedule[], lastError: string | null): void {
    if (updates.length === 0) return
    const statement = this.db.prepare(
      `UPDATE scrobble_queue
          SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
        WHERE id = ?`
    )
    this.db.transaction(() => {
      for (const update of updates) statement.run(update.nextAttemptAt, lastError, update.id)
    })()
  }

  /**
   * Record what went wrong without charging the row for it.
   *
   * For the terminal-for-the-account case: the session key is no longer valid,
   * so every queued row would fail identically, and spending an attempt each is
   * spending the backoff budget on a condition only the operator can clear. The
   * rows stay due; the drain stops because the target has disconnected itself
   * and the "skip disconnected targets" guard catches it on the next pass.
   */
  noteError(ids: readonly number[], lastError: string): void {
    if (ids.length === 0) return
    const statement = this.db.prepare('UPDATE scrobble_queue SET last_error = ? WHERE id = ?')
    this.db.transaction(() => {
      for (const id of ids) statement.run(lastError, id)
    })()
  }

  /**
   * How many rows are waiting, for one target or for all of them.
   *
   * Counts everything, not just what is due: a row backing off is still a
   * scrobble that has not been sent, and W11-7's "3 scrobbles waiting" would be
   * a lie that flickers if it only counted the ready ones.
   */
  depth(target?: ScrobbleTargetId): number {
    const row =
      target === undefined
        ? (this.db.prepare('SELECT COUNT(*) AS n FROM scrobble_queue').get() as { n: number })
        : (this.db
            .prepare('SELECT COUNT(*) AS n FROM scrobble_queue WHERE target = ?')
            .get(target) as { n: number })
    return row.n
  }

  /** The most recent error recorded for a target's remaining rows, if any. */
  lastError(target: ScrobbleTargetId): string | null {
    const row = this.db
      .prepare(
        `SELECT last_error FROM scrobble_queue
          WHERE target = ? AND last_error IS NOT NULL
          ORDER BY id DESC LIMIT 1`
      )
      .get(target) as { last_error: string } | undefined
    return row?.last_error ?? null
  }
}
