import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { openConfinedConnection } from '../../../src/main/mcp/sqlConfinement'

/**
 * The `query_library` confinement prototype — **W24-1**, `oscine-mcp` → D36.4.
 *
 * The main connection (better-sqlite3, migrated, WAL) writes; a `node:sqlite`
 * read-only connection with the authorizer reads alongside it. Every way a
 * statement could reach `settings` — directly, through a subquery, a CTE, the
 * schema table, a pragma function or a TEMP view — must fail at prepare.
 */
describe('query_library confinement', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let confined: DatabaseSync | undefined

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-mcp-confine-'))
    const path = join(dir, 'library.db')
    opened = openDatabase(path)
    const { db } = opened
    db.prepare(
      `INSERT INTO settings (key, scope_kind, value, version, updated_at)
       VALUES ('lastfm.session', 'global', '"secret"', 1, 1)`
    ).run()
    const root = db
      .prepare("INSERT INTO roots (label, path, added_at) VALUES ('Music', '/abs', 1)")
      .run().lastInsertRowid
    db.prepare(
      "INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, 'a.flac', 1, 1, 'A')"
    ).run(root)
    // W24-5's migration adds the real views; two stand-ins prove the rule.
    db.exec(`
      CREATE VIEW mcp_tracks AS SELECT id, title, root_id FROM tracks;
      CREATE VIEW mcp_roots AS SELECT id, label AS name FROM roots;
      CREATE VIEW leaky AS SELECT key, value FROM settings;
    `)
    confined = openConfinedConnection(path)
  })

  afterAll(() => {
    confined?.close()
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (sql: string): unknown[] => confined!.prepare(sql).all()

  it('reads through mcp_* views, joins and recursive CTEs included', () => {
    expect(run('SELECT title FROM mcp_tracks')).toEqual([{ title: 'A' }])
    expect(
      run('SELECT t.title, r.name FROM mcp_tracks t JOIN mcp_roots r ON r.id = t.root_id')
    ).toEqual([{ title: 'A', name: 'Music' }])
    expect(
      run(
        'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3) SELECT COUNT(*) AS c FROM n'
      )
    ).toEqual([{ c: 3 }])
    expect(run('SELECT COUNT(*) AS c FROM mcp_tracks')).toEqual([{ c: 1 }])
  })

  it('sees rows the main connection writes after it opened (WAL)', () => {
    opened.db.prepare("UPDATE tracks SET title = 'A2'").run()
    expect(run('SELECT title FROM mcp_tracks')).toEqual([{ title: 'A2' }])
    opened.db.prepare("UPDATE tracks SET title = 'A'").run()
  })

  it.each([
    ['settings directly', 'SELECT * FROM settings'],
    ['a base column no view reads', 'SELECT rel_path FROM tracks'],
    ['every column of a base table', 'SELECT * FROM tracks'],
    [
      'a hidden column through a CTE named like a real view',
      'WITH mcp_tracks AS (SELECT rel_path FROM tracks) SELECT * FROM mcp_tracks'
    ],
    [
      'a root path through a CTE',
      'WITH mcp_roots AS (SELECT path FROM roots) SELECT * FROM mcp_roots'
    ],
    [
      'settings in a subquery under an allowed view',
      "SELECT title FROM mcp_tracks WHERE (SELECT value FROM settings LIMIT 1) LIKE '%s%'"
    ],
    [
      'settings in a CTE named like a view',
      'WITH mcp_x AS (SELECT * FROM settings) SELECT * FROM mcp_x'
    ],
    ['a non-mcp view over settings', 'SELECT * FROM leaky'],
    ['the schema table', 'SELECT sql FROM sqlite_master'],
    ['a row count of settings', 'SELECT COUNT(*) FROM settings'],
    ['a row count of a pragma function', "SELECT COUNT(*) FROM pragma_table_info('settings')"],
    ['a pragma function', "SELECT * FROM pragma_table_info('settings')"],
    ['a pragma', 'PRAGMA table_info(settings)'],
    ['attach', "ATTACH DATABASE ':memory:' AS other"],
    ['a temp view laundering settings', 'CREATE TEMP VIEW mcp_launder AS SELECT * FROM settings'],
    ['a write', "UPDATE settings SET value = 'x'"],
    ['load_extension', "SELECT load_extension('x')"]
  ])('refuses %s at prepare', (_label, sql) => {
    expect(() => confined!.prepare(sql)).toThrow(/not authorized|prohibited|readonly|unable/i)
  })

  it('cannot be had from better-sqlite3, which exposes no authorizer', () => {
    expect('setAuthorizer' in opened.db).toBe(false)
  })
})
