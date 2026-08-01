import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { SqliteSettingsService } from '../../../src/main/settings'
import { THEME_MODE_KEY } from '../../../src/shared/settings'

/**
 * `interface.theme` becomes `theme.mode` without losing the operator's choice.
 *
 * Driven through the real migration list rather than by running the SQL,
 * because the thing that can break is the *step*: a library sitting at v7 with a
 * row in it, opened by a build that ships v8. A rename is the one shape of
 * change the kernel's version/upgrade machinery cannot help with — an old key
 * reads as unknown and is preserved untouched, so a migration that silently did
 * nothing would leave the choice intact on disk and invisible in the app.
 */

const OPEN: Database.Database[] = []

afterEach(() => {
  while (OPEN.length > 0) OPEN.pop()?.close()
})

interface Row {
  key: string
  scope_kind: string
  scope_id: number | null
  value: string
  version: number
  updated_at: number
}

/** A library as the build before this one left it: schema v7. */
function libraryAtV7(rows: readonly Partial<Row>[] = []): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  OPEN.push(db)

  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 7)
  )
  expect(db.pragma('user_version', { simple: true })).toBe(7)

  const insert = db.prepare(
    'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const row of rows) {
    insert.run(
      row.key ?? 'interface.theme',
      row.scope_kind ?? 'global',
      row.scope_id ?? null,
      row.value ?? '"dark"',
      row.version ?? 1,
      row.updated_at ?? 4242
    )
  }
  return db
}

function settingsRows(db: Database.Database, key: string): Row[] {
  return db
    .prepare<[string], Row>('SELECT * FROM settings WHERE key = ? ORDER BY scope_id')
    .all(key)
}

function toCurrent(db: Database.Database): void {
  migrate(db, MIGRATIONS)
  expect(db.pragma('user_version', { simple: true })).toBe(8)
}

describe('moving interface.theme to theme.mode', () => {
  it('carries the stored choice across, with its timestamp', () => {
    const db = libraryAtV7([{ value: '"light"', updated_at: 1234 }])
    toCurrent(db)

    const moved = settingsRows(db, THEME_MODE_KEY)
    expect(moved).toHaveLength(1)
    expect(moved[0]?.value).toBe('"light"')
    expect(moved[0]?.scope_kind).toBe('global')
    // The timestamp travels: the choice was made when it was made, and a
    // migration is not the operator changing their mind.
    expect(moved[0]?.updated_at).toBe(1234)
  })

  it('leaves nothing behind under the old name', () => {
    // A surviving row would be harmless today — unknown keys are handed back to
    // disk — and would silently reappear as an override the day anything else
    // claims that name.
    const db = libraryAtV7([{ value: '"dark"' }])
    toCurrent(db)
    expect(settingsRows(db, 'interface.theme')).toEqual([])
  })

  it('resolves through the real service afterwards', () => {
    // The point of the whole exercise: the value is not merely present in the
    // table, it is what the app reads.
    const db = libraryAtV7([{ value: '"dark"' }])
    toCurrent(db)
    expect(new SqliteSettingsService({ db }).get<string>(THEME_MODE_KEY)).toBe('dark')
  })

  it('is a no-op on a library that never stored a theme', () => {
    const db = libraryAtV7()
    toCurrent(db)
    expect(settingsRows(db, THEME_MODE_KEY)).toEqual([])
    // ...and the key still resolves, from its descriptor default.
    expect(new SqliteSettingsService({ db }).get<string>(THEME_MODE_KEY)).toBe('system')
  })

  it('does not clobber a row a newer build already wrote', () => {
    // `theme.mode` existing already means a build that knew the new name has
    // run, which makes it newer than the one being retired.
    const db = libraryAtV7([
      { value: '"dark"' },
      { key: THEME_MODE_KEY, value: '"light"', updated_at: 9999 }
    ])
    toCurrent(db)

    const moved = settingsRows(db, THEME_MODE_KEY)
    expect(moved).toHaveLength(1)
    expect(moved[0]?.value).toBe('"light"')
    expect(settingsRows(db, 'interface.theme')).toEqual([])
  })

  it('ignores a row at a scope the key never cascaded to', () => {
    // `interface.theme` was global-only, so a playlist-scoped row is something
    // no build wrote. Moving it would be inventing intent; it is dropped with
    // the rest of the old key.
    const db = libraryAtV7([{ scope_kind: 'playlist', scope_id: 7, value: '"dark"' }])
    toCurrent(db)
    expect(settingsRows(db, THEME_MODE_KEY)).toEqual([])
  })

  it('is a no-op on second launch', () => {
    const db = libraryAtV7([{ value: '"dark"' }])
    toCurrent(db)
    const after = settingsRows(db, THEME_MODE_KEY)

    const again = migrate(db, MIGRATIONS)
    expect(again.from).toBe(8)
    expect(again.to).toBe(8)
    expect(settingsRows(db, THEME_MODE_KEY)).toEqual(after)
  })
})
