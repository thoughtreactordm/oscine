import Database from 'better-sqlite3'
import { migrate, type MigrationResult } from './migrate'
import { MIGRATIONS } from './migrations'

export { migrate, SchemaTooNewError } from './migrate'
export type { Migration, MigrationResult } from './migrate'
export { createPathHelpers, toAbsPath, toRelPath } from './paths'
export type { PathHelpers } from './paths'
export { MIGRATIONS } from './migrations'

export interface OpenDatabaseResult {
  db: Database.Database
  migration: MigrationResult
}

/**
 * Opens the library database at `filePath`, configures the connection and brings
 * the schema up to date.
 *
 * Deliberately takes a path and imports nothing from Electron: that keeps the
 * whole persistence layer testable under plain Node. `libraryDatabasePath` in
 * ./location.ts is the only piece that knows about `userData`.
 */
export function openDatabase(filePath: string): OpenDatabaseResult {
  const db = new Database(filePath)

  try {
    // Concurrent read during background scans (W2-2 walks a library while the
    // UI queries it). Must be set before any transaction opens; it persists in
    // the database file, so this is a no-op on subsequent launches.
    db.pragma('journal_mode = WAL')

    // Set explicitly even though better-sqlite3 already defaults it on — which
    // raw SQLite does not. Relying on a driver default for this would mean every
    // ON DELETE CASCADE in schema v1 becoming a silent no-op if that default
    // ever changed, and the symptom is rows outliving their root rather than an
    // error. The pragma is per-connection, never stored in the file.
    db.pragma('foreign_keys = ON')

    // Safe specifically because of WAL: a crash can cost the most recent commits
    // but cannot corrupt the database. For a library rebuilt by rescanning a
    // folder, that trade is heavily in favour of scan throughput.
    db.pragma('synchronous = NORMAL')

    // A scan's write transaction can briefly block a UI read. Wait rather than
    // throwing SQLITE_BUSY at the user.
    db.pragma('busy_timeout = 5000')

    const migration = migrate(db, MIGRATIONS)
    return { db, migration }
  } catch (error) {
    // A half-open connection would keep the file and its -wal locked.
    db.close()
    throw error
  }
}
