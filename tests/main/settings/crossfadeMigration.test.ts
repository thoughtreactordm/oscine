import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { SqliteSettingsService } from '../../../src/main/settings'
import { AUDIO_CROSSFADE_MS, GLOBAL_SCOPE } from '../../../src/shared/settings'

/**
 * The card's second exit criterion: an operator who set a per-playlist crossfade
 * keeps it.
 *
 * Driven through the real migration list rather than by calling the SQL
 * directly, because the thing that could break is the *step* — a library sitting
 * at v6 with rows in it, opened by a build that ships v7.
 */

const OPEN: Database.Database[] = []

afterEach(() => {
  while (OPEN.length > 0) OPEN.pop()?.close()
})

/** A library as the build before this one left it: schema v6, playlists with rows. */
function libraryAtV6(
  playlists: readonly { name: string; crossfadeMs: number }[]
): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  OPEN.push(db)

  const before = MIGRATIONS.filter((migration) => migration.version <= 6)
  migrate(db, before)
  expect(db.pragma('user_version', { simple: true })).toBe(6)

  const insert = db.prepare(
    'INSERT INTO playlists (name, position, crossfade_ms, created_at, updated_at) ' +
      'VALUES (?, ?, ?, 1000, 2000)'
  )
  playlists.forEach((playlist, index) => {
    insert.run(playlist.name, index, playlist.crossfadeMs)
  })
  return db
}

interface OverrideRow {
  scope_id: number
  value: string
  version: number
  updated_at: number
}

function overrideRows(db: Database.Database): OverrideRow[] {
  return db
    .prepare<[], OverrideRow>(
      'SELECT scope_id, value, version, updated_at FROM settings ' +
        "WHERE key = 'audio.crossfadeMs' AND scope_kind = 'playlist' ORDER BY scope_id"
    )
    .all()
}

describe('folding per-playlist crossfade into the cascade', () => {
  it('carries a set value across as an override row', () => {
    const db = libraryAtV6([
      { name: 'Live sets', crossfadeMs: 2500 },
      { name: 'Untouched', crossfadeMs: 0 },
      { name: 'Radio', crossfadeMs: 750 }
    ])

    migrate(db, MIGRATIONS)

    expect(overrideRows(db)).toEqual([
      // Playlist 1 and 3. The zero is absence of a choice, not a choice of zero —
      // every playlist created without one holds it, and writing overrides for
      // all of them would pin the whole library against a later global change.
      { scope_id: 1, value: '2500', version: 1, updated_at: 2000 },
      { scope_id: 3, value: '750', version: 1, updated_at: 2000 }
    ])
  })

  it('resolves the migrated value through the cascade it moved into', () => {
    const db = libraryAtV6([{ name: 'Live sets', crossfadeMs: 2500 }])
    migrate(db, MIGRATIONS)

    const settings = new SqliteSettingsService({ db })

    expect(settings.resolve(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 1 })).toMatchObject({
      value: 2500,
      overridden: true,
      provenance: { level: 'stored', scope: { kind: 'playlist', id: 1 } }
    })
    // The global is untouched by the move, so the playlist genuinely overrides.
    expect(settings.resolve(AUDIO_CROSSFADE_MS, GLOBAL_SCOPE).value).toBe(0)
  })

  it('survives a value the descriptor would clamp', () => {
    // Schema v1 put no ceiling on the column; the descriptor caps at 12 seconds.
    const db = libraryAtV6([{ name: 'Absurd', crossfadeMs: 90_000 }])
    migrate(db, MIGRATIONS)

    // Moved verbatim — the migration does not second-guess the value, and the
    // clamp happens on read where every other repair happens.
    expect(overrideRows(db)[0]?.value).toBe('90000')
    expect(
      new SqliteSettingsService({ db }).resolve(AUDIO_CROSSFADE_MS, { kind: 'playlist', id: 1 })
        .value
    ).toBe(12_000)
  })

  it('leaves an override that already exists alone', () => {
    const db = libraryAtV6([{ name: 'Live sets', crossfadeMs: 2500 }])
    db.prepare(
      'INSERT INTO settings (key, scope_kind, scope_id, value, version, updated_at) ' +
        "VALUES ('audio.crossfadeMs', 'playlist', 1, '4000', 1, 9999)"
    ).run()

    migrate(db, MIGRATIONS)

    expect(overrideRows(db)).toEqual([{ scope_id: 1, value: '4000', version: 1, updated_at: 9999 }])
  })

  it('leaves no settings column on the playlists table', () => {
    const db = libraryAtV6([{ name: 'Live sets', crossfadeMs: 2500 }])
    migrate(db, MIGRATIONS)

    const columns = db
      .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
      .all('playlists')
      .map((column) => column.name)

    expect(columns).not.toContain('crossfade_ms')
    expect(columns).toEqual(['id', 'name', 'position', 'created_at', 'updated_at'])
  })

  it('keeps the playlists themselves intact', () => {
    const db = libraryAtV6([
      { name: 'Live sets', crossfadeMs: 2500 },
      { name: 'Untouched', crossfadeMs: 0 }
    ])
    migrate(db, MIGRATIONS)

    expect(
      db.prepare<[], { name: string }>('SELECT name FROM playlists ORDER BY position').all()
    ).toEqual([{ name: 'Live sets' }, { name: 'Untouched' }])
  })

  it('is a no-op on a library that has no playlists', () => {
    const db = libraryAtV6([])
    migrate(db, MIGRATIONS)

    expect(overrideRows(db)).toEqual([])
    expect(db.pragma('user_version', { simple: true })).toBe(8)
  })
})
