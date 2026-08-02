/**
 * Opening a database whose correct response to almost any problem is to throw
 * itself away.
 *
 * `db/index.ts` opens the library, and every decision it makes is downstream of
 * the library being irreplaceable: a schema it does not understand is a refusal,
 * a corrupt file is a visible error, and nothing is ever deleted. This file
 * opens the cache, where every one of those answers is wrong. There is no
 * information in `cache.db` that is not also on a server, so the cheapest
 * correct response to *any* difficulty reading it is `rm` and start again.
 *
 * That is not a shortcut, it is the acceptance criterion. "Deleting `cache.db`
 * while the app is closed loses nothing but speed" is only true if the app
 * treats a missing cache as ordinary — and a build that copes with the file
 * being absent but not with it being damaged has satisfied the letter of that
 * and none of its point. Both arrive at the same place here.
 *
 * ## The rollback case is the one this is really for
 *
 * D11 makes the database machine-local, but the same machine can be rolled back
 * to an older Fermata. The library refuses in that situation because continuing
 * would write rows the newer build cannot read. The cache has no such problem:
 * it discards a schema from the future and rebuilds an empty one, so an operator
 * downgrading loses a few days of lookups instead of losing their app.
 */

import Database from 'better-sqlite3'
import { rmSync } from 'node:fs'
import { migrate, type MigrationResult } from '../db/migrate'
import { CACHE_MIGRATIONS } from './migrations'

export interface OpenCacheDatabaseResult {
  db: Database.Database
  migration: MigrationResult
  /** True when the existing file was unusable and was replaced with an empty one. */
  rebuilt: boolean
  /** Why it was rebuilt, for the log line. `null` when it was not. */
  rebuiltBecause: string | null
}

/**
 * Removes a SQLite database and the two files WAL mode keeps beside it.
 *
 * Leaving the `-wal` behind is the failure mode worth naming: SQLite will
 * happily replay an orphaned write-ahead log into a newly created database of
 * the same name, which resurrects exactly the corruption we deleted the file to
 * escape.
 */
function discardDatabaseFiles(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${filePath}${suffix}`, { force: true })
  }
}

function configure(db: Database.Database): void {
  // Must precede the first table, and therefore the first migration: SQLite can
  // only change this on an empty database or through a full VACUUM. Incremental
  // rather than full because eviction runs mid-session and a full auto-vacuum
  // repacks on every commit; incremental lets `store.ts` hand pages back at the
  // one moment it knows a lot of them just became free. Without it the size cap
  // is a cap on rows and not on the file, which is not what was asked for.
  db.pragma('auto_vacuum = INCREMENTAL')

  db.pragma('journal_mode = WAL')

  // NORMAL, not OFF, even though this file is disposable. With WAL, NORMAL can
  // lose the last few commits on power loss but cannot corrupt; OFF can corrupt,
  // and our recovery from corruption is to delete the whole cache. Trading "lose
  // three lookups" for "lose all of them" to save an fsync we were not waiting
  // on is a bad trade.
  db.pragma('synchronous = NORMAL')

  db.pragma('busy_timeout = 5000')

  // No `foreign_keys` pragma: the schema has no references, by design. See the
  // migration.
}

function attempt(filePath: string): OpenCacheDatabaseResult {
  const db = new Database(filePath)
  try {
    configure(db)
    return { db, migration: migrate(db, CACHE_MIGRATIONS), rebuilt: false, rebuiltBecause: null }
  } catch (error) {
    // A half-open connection would keep the file and its -wal locked, which is
    // fatal here specifically: the recovery path is about to try to delete them.
    db.close()
    throw error
  }
}

/**
 * Opens the cache, replacing it if it cannot be opened or understood.
 *
 * Every failure is caught, not just the ones we can name. `SchemaTooNewError`
 * and `SQLITE_CORRUPT` are the two we expect, and enumerating them would mean
 * the third one — a truncated file, a directory where the file should be, a
 * driver upgrade that rejects something older — reaching the caller as a startup
 * crash over a cache. The set of things worth failing to launch for does not
 * include this file.
 *
 * The retry is deliberately single. If a freshly deleted path cannot be created
 * and migrated, the problem is the directory rather than the database, and
 * looping on it would only delay the report.
 */
export function openCacheDatabase(filePath: string): OpenCacheDatabaseResult {
  try {
    return attempt(filePath)
  } catch (error) {
    const because = error instanceof Error ? error.message : String(error)
    discardDatabaseFiles(filePath)
    return { ...attempt(filePath), rebuilt: true, rebuiltBecause: because }
  }
}
