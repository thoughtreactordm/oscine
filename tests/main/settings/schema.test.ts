import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'

const openDatabases: Database.Database[] = []

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close()
})

function trackDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  openDatabases.push(db)
  return db
}

const insert =
  'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, 1)'

describe('the settings migration', () => {
  it('applies on a fresh database', () => {
    const db = trackDb()

    const result = migrate(db, MIGRATIONS)

    expect(result.from).toBe(0)
    expect(result.applied.map((migration) => migration.name)).toContain('settings')
    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 0 })
  })

  it('applies on a database that stopped at the migration before it', () => {
    const db = trackDb()
    const earlier = MIGRATIONS.filter((migration) => migration.version < 6)

    migrate(db, earlier)
    // Stopped at 6 rather than run to HEAD: this is about the step that creates
    // the table, and later steps have their own tests.
    const result = migrate(
      db,
      MIGRATIONS.filter((migration) => migration.version <= 6)
    )

    expect(result).toMatchObject({ from: 5, to: 6 })
    expect(result.applied.map((migration) => migration.name)).toEqual(['settings'])
  })

  it('rejects a second global row for the same key', () => {
    const db = trackDb()
    migrate(db, MIGRATIONS)

    db.prepare(insert).run('audio.crossfadeMs', 'global', null, '0', 1)

    // The declared primary key does not catch this: SQLite leaves PRIMARY KEY
    // columns of a rowid table nullable, and a unique index treats two NULLs as
    // distinct. Without the COALESCE index this insert succeeds and the table
    // holds two answers for one key.
    expect(() => db.prepare(insert).run('audio.crossfadeMs', 'global', null, '1500', 1)).toThrow(
      /UNIQUE constraint failed/
    )
  })

  it('keeps one row per scope for the same key', () => {
    const db = trackDb()
    migrate(db, MIGRATIONS)

    db.prepare(insert).run('audio.crossfadeMs', 'global', null, '0', 1)
    db.prepare(insert).run('audio.crossfadeMs', 'playlist', 7, '1500', 1)
    db.prepare(insert).run('audio.crossfadeMs', 'playlist', 8, '3000', 1)
    db.prepare(insert).run('audio.crossfadeMs', 'album', 7, '250', 1)

    expect(db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual({ n: 4 })
    expect(() => db.prepare(insert).run('audio.crossfadeMs', 'playlist', 7, '99', 1)).toThrow(
      /UNIQUE constraint failed/
    )
  })
})
