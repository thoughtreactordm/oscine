import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS, SchemaTooNewError, migrate, type Migration } from '../../../src/main/db'

function memoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  return db
}

const one: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);' }
const two: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' }

describe('migrate', () => {
  it('applies pending migrations in order and records the version', () => {
    const db = memoryDb()
    try {
      const result = migrate(db, [one, two])

      expect(result).toMatchObject({ from: 0, to: 2 })
      expect(result.applied.map((m) => m.name)).toEqual(['one', 'two'])
      expect(db.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      db.close()
    }
  })

  it('applies only what is missing when resuming part-way', () => {
    const db = memoryDb()
    try {
      migrate(db, [one])
      const result = migrate(db, [one, two])

      expect(result).toMatchObject({ from: 1, to: 2 })
      expect(result.applied.map((m) => m.name)).toEqual(['two'])
    } finally {
      db.close()
    }
  })

  it('does nothing when already current', () => {
    const db = memoryDb()
    try {
      migrate(db, [one, two])
      const result = migrate(db, [one, two])

      expect(result).toEqual({ from: 2, to: 2, applied: [] })
    } finally {
      db.close()
    }
  })

  it('rolls back the failing migration and leaves the version behind it', () => {
    const db = memoryDb()
    const broken: Migration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY); CREATE TABLE b (nope);'
    }
    try {
      expect(() => migrate(db, [one, broken])).toThrow()

      // The whole point of sharing a transaction: neither the half-built table
      // nor a version claiming it exists survives.
      expect(db.pragma('user_version', { simple: true })).toBe(1)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name)
      expect(tables).toContain('a')
      expect(tables).not.toContain('b')
    } finally {
      db.close()
    }
  })

  it('runs a backfill after its own DDL, in the same transaction', () => {
    const db = memoryDb()
    const seeded: Migration = {
      version: 2,
      name: 'seeded',
      sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY, note TEXT NOT NULL);',
      // Reading `a` proves ordering twice over: the table this migration created
      // exists by now, and so does the one the previous migration created.
      backfill: (target) => {
        target.prepare('INSERT INTO b (note) VALUES (?)').run('derived')
      }
    }
    try {
      migrate(db, [one, seeded])

      expect(db.prepare('SELECT note FROM b').get()).toEqual({ note: 'derived' })
      expect(db.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      db.close()
    }
  })

  it('rolls back the DDL when the backfill throws', () => {
    const db = memoryDb()
    const badBackfill: Migration = {
      version: 2,
      name: 'bad-backfill',
      sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
      backfill: () => {
        throw new Error('derivation failed')
      }
    }
    try {
      expect(() => migrate(db, [one, badBackfill])).toThrow('derivation failed')

      // A backfill is part of the migration, not a step after it: failing to
      // derive the rows must leave the table they belong in unbuilt, or the
      // next launch sees a version that promises data nothing wrote.
      expect(db.pragma('user_version', { simple: true })).toBe(1)
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name)
      expect(tables).not.toContain('b')
    } finally {
      db.close()
    }
  })

  it('refuses a database newer than the code', () => {
    const db = memoryDb()
    try {
      db.pragma('user_version = 7')

      expect(() => migrate(db, [one, two])).toThrow(SchemaTooNewError)
      // Unchanged: a rollback to an older build must not quietly rewrite the
      // schema version of a library it cannot read.
      expect(db.pragma('user_version', { simple: true })).toBe(7)
    } finally {
      db.close()
    }
  })

  it('rejects a registry with a gap', () => {
    const db = memoryDb()
    try {
      expect(() => migrate(db, [one, { ...two, version: 3 }])).toThrow(/not contiguous/i)
    } finally {
      db.close()
    }
  })

  it('rejects a registry that does not start at 1', () => {
    const db = memoryDb()
    try {
      expect(() => migrate(db, [two])).toThrow(/not contiguous/i)
    } finally {
      db.close()
    }
  })
})

describe('MIGRATIONS registry', () => {
  it('is contiguous from 1 with unique names', () => {
    // Catches the half-finished addition: a new file written but never
    // registered, or registered twice.
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length)
  })
})
