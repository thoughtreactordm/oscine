/**
 * The SQL half of the cache: rows, bytes and eviction. Knows nothing about
 * MusicBrainz, TTL policy or `NetResult` — it is handed an expiry and stores it.
 *
 * ## Eviction is LRU with a low-water mark
 *
 * Two deletes, in this order, whenever a write pushes the total past the cap.
 * Expired rows go first because they are free: nothing is lost by dropping a row
 * that the next read would have discarded anyway, and on a cache that has been
 * sitting idle for a month that single statement is usually the whole eviction.
 * Only what remains is evicted by least-recent use.
 *
 * The second delete frees down to `evictToBytes` rather than to the cap, because
 * a cache trimmed to exactly its limit is over the limit again on the very next
 * write. That turns eviction from an occasional cost into a per-lookup one — an
 * LRU sort of the entire table on every artist the operator plays — and it is
 * the failure mode that makes a naive cap slower than no cache at all.
 */

import type Database from 'better-sqlite3'
import type { CacheEntity, CachePolicy } from './policy'

export interface StoredRow {
  /** JSON text, or `null` for a negative entry. */
  payload: string | null
  storedAt: number
  expiresAt: number
  usedAt: number
}

export interface CacheStats {
  entries: number
  /** Payload plus per-row overhead, the same figure the cap is measured against. */
  bytes: number
  /** How many of those rows are cached "the service has nothing for this". */
  negatives: number
}

export interface CacheStore {
  read(entity: CacheEntity, key: string, now: number): StoredRow | null
  /**
   * Upserts an entry and evicts if that put the cache over its cap.
   *
   * Returns false when the payload is too large to be worth keeping — the caller
   * gets its answer either way, so this is a fact for tests and logs rather than
   * a failure.
   */
  write(
    entity: CacheEntity,
    key: string,
    payload: string | null,
    expiresAt: number,
    now: number
  ): boolean
  clear(): void
  stats(): CacheStats
}

/**
 * How stale a row's `used_at` may be before a read bothers to update it.
 *
 * A read is otherwise a write, and the deck re-reads the same artist every time
 * the operator switches panes. LRU does not need second-level resolution — it
 * needs to know which entries have not been touched in weeks — so a minute of
 * granularity costs eviction nothing and saves the common case an fsync-backed
 * transaction it had no reason to perform.
 */
const USED_AT_GRANULARITY_MS = 60_000

export function createCacheStore(db: Database.Database, policy: CachePolicy): CacheStore {
  const selectEntry = db.prepare<[string, string]>(
    'SELECT payload, stored_at AS storedAt, expires_at AS expiresAt, used_at AS usedAt ' +
      'FROM cache_entries WHERE entity = ? AND key = ?'
  )

  const touchEntry = db.prepare<[number, string, string]>(
    'UPDATE cache_entries SET used_at = ? WHERE entity = ? AND key = ?'
  )

  // `used_at` is set on insert and left alone on conflict-update for the same
  // reason it is a separate column: a refresh is not a use. The row keeps the
  // recency it had earned, and the next read gives it a new one.
  const upsertEntry = db.prepare<[string, string, string | null, number, number, number, number]>(
    `INSERT INTO cache_entries (entity, key, payload, size_bytes, stored_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity, key) DO UPDATE SET
       payload    = excluded.payload,
       size_bytes = excluded.size_bytes,
       stored_at  = excluded.stored_at,
       expires_at = excluded.expires_at`
  )

  const deleteExpired = db.prepare<[number]>('DELETE FROM cache_entries WHERE expires_at <= ?')

  /**
   * Deletes least-recently-used rows until `toFree` bytes have gone.
   *
   * The window function is a running total over the table in eviction order, and
   * `running - size_bytes < :toFree` is what includes the row that crosses the
   * threshold rather than stopping just short of it: for that row the total
   * *before* it is still under, so it is taken, and for every row after it the
   * total before is already over, so they are not. `rowid` breaks ties on
   * `used_at`, which the granularity above makes common.
   */
  const deleteLeastRecentlyUsed = db.prepare<[number]>(
    `DELETE FROM cache_entries WHERE rowid IN (
       SELECT rowid FROM (
         SELECT rowid, size_bytes,
                SUM(size_bytes) OVER (ORDER BY used_at, rowid) AS running
         FROM cache_entries
       )
       WHERE running - size_bytes < ?
     )`
  )

  const selectStats = db.prepare(
    `SELECT COUNT(*) AS entries,
            COALESCE(SUM(size_bytes), 0) AS bytes,
            COALESCE(SUM(payload IS NULL), 0) AS negatives
     FROM cache_entries`
  )

  const deleteAll = db.prepare('DELETE FROM cache_entries')

  const totalBytes = (): number => (selectStats.get() as CacheStats).bytes

  const sizeOf = (payload: string | null): number =>
    (payload === null ? 0 : Buffer.byteLength(payload, 'utf8')) + policy.rowOverheadBytes

  /**
   * One transaction so that a crash mid-eviction cannot leave the cache over its
   * cap with the write applied — and, more usefully, so the two deletes and the
   * insert see one consistent total rather than three.
   */
  const writeAndEvict = db.transaction(
    (
      entity: string,
      key: string,
      payload: string | null,
      size: number,
      expiresAt: number,
      now: number
    ): boolean => {
      upsertEntry.run(entity, key, payload, size, now, expiresAt, now)

      if (totalBytes() <= policy.maxBytes) return false

      deleteExpired.run(now)

      const remaining = totalBytes()
      if (remaining <= policy.maxBytes) return true

      deleteLeastRecentlyUsed.run(remaining - policy.evictToBytes)
      return true
    }
  )

  /**
   * Hands freed pages back to the filesystem.
   *
   * Run outside the transaction and only after an eviction actually happened.
   * SQLite does not shrink a file when rows are deleted, so without this the cap
   * would bound what the cache *contains* while the file it lives in only ever
   * grew — technically a cap, and not the one anybody meant.
   */
  const reclaim = (): void => {
    db.pragma('incremental_vacuum')
  }

  return {
    read(entity, key, now): StoredRow | null {
      const row = selectEntry.get(entity, key) as StoredRow | undefined
      if (!row) return null

      if (now - row.usedAt >= USED_AT_GRANULARITY_MS) {
        touchEntry.run(now, entity, key)
      }

      return row
    },

    write(entity, key, payload, expiresAt, now): boolean {
      const size = sizeOf(payload)
      if (size > policy.maxEntryBytes) return false

      if (writeAndEvict(entity, key, payload, size, expiresAt, now)) reclaim()
      return true
    },

    clear(): void {
      deleteAll.run()
      reclaim()
    },

    stats(): CacheStats {
      return selectStats.get() as CacheStats
    }
  }
}
