import type Database from 'better-sqlite3'

/**
 * One forward-only schema step.
 *
 * There is no `down`. Rolling a schema backwards on a user's library is a way to
 * lose data quietly; the recovery path for a bad migration is a fixed release
 * carrying a new forward migration, not an automated reversal.
 */
export interface Migration {
  /** 1-based, contiguous, and permanent once released. */
  version: number
  /** Human label for logs — has no effect on ordering. */
  name: string
  sql: string
  /**
   * An optional JavaScript step, run after `sql` and inside the same transaction.
   *
   * For the migration whose backfill is a rule the application already owns.
   * Migration 013 splits `tracks.genre` into `track_genres` using the splitter in
   * `@shared/genre`, and the alternative — a recursive CTE reimplementing the
   * same separators, trimming and casefolding in SQL — would be a second
   * definition of that rule, drifting from the first the moment either changes.
   * SQLite's `lower()` is ASCII-only, so the two would already disagree on the
   * first non-English genre in the library.
   *
   * Being inside the transaction is the point: a backfill that throws rolls back
   * its own DDL and leaves `user_version` behind it, exactly like a failing
   * `sql`. Use it for deriving rows from rows. Anything that touches the
   * filesystem or the network belongs in a rescan, not here.
   */
  backfill?: (db: Database.Database) => void
}

export interface MigrationResult {
  /** `user_version` before this run. 0 on a fresh database. */
  from: number
  /** `user_version` after this run. */
  to: number
  applied: Migration[]
}

/**
 * Thrown when the database is newer than the code that opened it.
 *
 * D11 gives each machine its own database, but the same machine can be rolled
 * back to an older Fermata build. Continuing against a schema we do not
 * understand would write rows the newer build cannot read, so this refuses.
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(
      `Database schema version ${found} is newer than this build supports (${supported}). ` +
        'This library was written by a newer version of Fermata.'
    )
    this.name = 'SchemaTooNewError'
  }
}

/**
 * Guards against the registry silently losing or duplicating a migration —
 * a missing file would otherwise present as "nothing to do" and leave a
 * half-built schema that only fails much later, at first query.
 */
function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1
    if (migration.version !== expected) {
      throw new Error(
        `Migration registry is not contiguous: expected version ${expected} at index ${index}, ` +
          `found ${migration.version} (${migration.name}).`
      )
    }
  })
}

/**
 * Applies every migration newer than the database's `user_version`.
 *
 * Each migration and its version bump share one transaction, so an interrupted
 * upgrade leaves the database at the last fully-applied version rather than
 * somewhere between two. `user_version` lives in the database header and is
 * itself transactional, which is what makes that possible.
 *
 * Note for whoever writes migration 2+: `PRAGMA foreign_keys` is a no-op inside
 * a transaction, so a migration needing the 12-step table rebuild cannot simply
 * turn it off here. It has to be toggled by the caller around `migrate`.
 */
export function migrate(db: Database.Database, migrations: readonly Migration[]): MigrationResult {
  assertContiguous(migrations)

  const from = db.pragma('user_version', { simple: true }) as number
  const latest = migrations.length

  if (from > latest) throw new SchemaTooNewError(from, latest)

  const pending = migrations.filter((migration) => migration.version > from)
  const applied: Migration[] = []

  for (const migration of pending) {
    // Interpolated rather than bound: SQLite does not accept a parameter in a
    // PRAGMA. The value is an integer we just validated as contiguous, not input.
    if (!Number.isInteger(migration.version)) {
      throw new Error(`Migration ${migration.name} has a non-integer version.`)
    }

    db.transaction(() => {
      db.exec(migration.sql)
      migration.backfill?.(db)
      db.pragma(`user_version = ${migration.version}`)
    })()

    applied.push(migration)
  }

  return { from, to: db.pragma('user_version', { simple: true }) as number, applied }
}
