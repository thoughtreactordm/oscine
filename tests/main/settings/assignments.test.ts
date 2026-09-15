import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { SqliteSettingsService } from '../../../src/main/settings'
import { AUDIO_EQ_PRESET_ID } from '../../../src/shared/settings'

/**
 * `listAssignments` is the inverse read W19-6 needs: "which entities point at a
 * preset", a question no per-scope `getOverrides` can answer and the cascade
 * never asks at play time. These prove it enumerates every entity scope, drops
 * what it must, and never leaks the global floor.
 */

const openDatabases: Database.Database[] = []

afterEach(() => {
  for (const db of openDatabases) db.close()
  openDatabases.length = 0
})

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db, MIGRATIONS)
  openDatabases.push(db)
  return db
}

/** Seed rows straight into the table so a non-cascade scope and a malformed row
 * — neither writable through `set` — can be placed on purpose. */
function seed(
  db: Database.Database,
  entries: readonly { key: string; scope: [string, number | null]; value: string }[]
): void {
  const insert = db.prepare(
    'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
      'VALUES (?, ?, ?, ?, 1, 1)'
  )
  for (const entry of entries) {
    insert.run(entry.key, entry.scope[0], entry.scope[1], entry.value)
  }
}

function service(db: Database.Database): SqliteSettingsService {
  return new SqliteSettingsService({ db, now: () => 1_700_000_000_000 })
}

describe('listAssignments', () => {
  const key = AUDIO_EQ_PRESET_ID.key

  it('returns every entity that overrides the key, most kinds at once', () => {
    const db = freshDb()
    seed(db, [
      { key, scope: ['album', 12], value: '"preset-a"' },
      { key, scope: ['artist', 7], value: '"preset-b"' },
      { key, scope: ['playlist', 3], value: '"preset-a"' }
    ])

    const result = service(db).listAssignments(key)

    expect(result.key).toBe(key)
    expect(result.notices).toEqual([])
    expect(result.assignments).toEqual(
      expect.arrayContaining([
        { scope: { kind: 'album', id: 12 }, stored: { value: 'preset-a', version: 1 } },
        { scope: { kind: 'artist', id: 7 }, stored: { value: 'preset-b', version: 1 } },
        { scope: { kind: 'playlist', id: 3 }, stored: { value: 'preset-a', version: 1 } }
      ])
    )
    expect(result.assignments).toHaveLength(3)
  })

  it('never leaks the global floor', () => {
    const db = freshDb()
    seed(db, [
      { key, scope: ['global', null], value: '"global-preset"' },
      { key, scope: ['album', 1], value: '"preset-a"' }
    ])

    const result = service(db).listAssignments(key)

    expect(result.assignments).toEqual([
      { scope: { kind: 'album', id: 1 }, stored: { value: 'preset-a', version: 1 } }
    ])
  })

  it('drops a row at a scope the key does not cascade to', () => {
    const db = freshDb()
    // audio.eq.presetId cascades to album/artist/playlist — not track.
    seed(db, [
      { key, scope: ['track', 99], value: '"preset-a"' },
      { key, scope: ['album', 1], value: '"preset-a"' }
    ])

    const result = service(db).listAssignments(key)

    expect(result.assignments).toEqual([
      { scope: { kind: 'album', id: 1 }, stored: { value: 'preset-a', version: 1 } }
    ])
  })

  it('reports a malformed row rather than dropping it silently', () => {
    const db = freshDb()
    seed(db, [{ key, scope: ['album', 1], value: 'not json' }])

    const result = service(db).listAssignments(key)

    expect(result.assignments).toEqual([])
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]?.key).toBe(key)
  })

  it('is empty for a key no descriptor answers to', () => {
    const db = freshDb()
    seed(db, [{ key: 'not.a.key', scope: ['album', 1], value: '"x"' }])

    expect(service(db).listAssignments('not.a.key').assignments).toEqual([])
  })
})
