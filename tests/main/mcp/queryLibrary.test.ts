import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import { createQueryHost, type QueryHost } from '../../../src/main/mcp/query/host'
import type { QueryResult, QueryRows } from '../../../src/main/mcp/query/protocol'
import { runQuery } from '../../../src/main/mcp/query/run'
import { singleStatement } from '../../../src/main/mcp/query/statement'
import { openConfinedConnection } from '../../../src/main/mcp/sqlConfinement'
import { bundleQueryWorker, RM_RETRY, type QueryProcessHarness } from './queryProcess'

/**
 * `query_library` — **W24-5**, `oscine-mcp` → D36.4, D36.4.2, R19.
 *
 * On the real migrated schema with the real `mcp_*` views (029): the refusals,
 * the confinement holding against direct and indirect references, the row cap,
 * effective values matching the track list, and — through a real forked query
 * process — a runaway statement killed at its deadline while main's own
 * connection keeps answering.
 */

const ROOT_PATH = '/home/someone/secret-music-root'
const TRACKS = 60

describe('the one-statement rule', () => {
  it.each([
    ['SELECT 1', true],
    ['SELECT 1;', true],
    ['SELECT 1;  -- trailing comment\n ; /* and another */', true],
    ["SELECT 'a;b' AS x", true],
    ['SELECT "odd;name" FROM mcp_tracks', true],
    ['SELECT [a;b] FROM mcp_tracks', true],
    ["SELECT 'it''s; fine'", true],
    ['SELECT 1 /* ; */', true],
    ['SELECT 1; SELECT 2', false],
    ['SELECT 1; DELETE FROM settings', false],
    ["SELECT ';'; ATTACH 'x' AS y", false],
    ['SELECT 1 -- ;\n; VACUUM', false]
  ])('%s → %s', (sql, ok) => {
    expect(singleStatement(sql).ok).toBe(ok)
  })

  it('calls nothing but comments empty', () => {
    expect(singleStatement('  -- nothing\n /* here */ ')).toEqual({ ok: false, reason: 'empty' })
    expect(singleStatement(';')).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('query_library on the real views', () => {
  let dir: string
  let path: string
  let opened: OpenDatabaseResult
  let confined: DatabaseSync
  let overriddenId: number
  let plainId: number

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-query-library-'))
    path = join(dir, 'library.db')
    opened = openDatabase(path)
    const { db } = opened
    db.prepare(
      `INSERT INTO settings (key, scope_kind, value, version, updated_at)
       VALUES ('lastfm.session', 'global', '"secret-session-key"', 1, 1)`
    ).run()
    const root = Number(
      db.prepare("INSERT INTO roots (label, path, added_at) VALUES ('Music', ?, 1)").run(ROOT_PATH)
        .lastInsertRowid
    )
    const artist = Number(
      db.prepare("INSERT INTO artists (name) VALUES ('Original Artist')").run().lastInsertRowid
    )
    const album = Number(
      db
        .prepare("INSERT INTO albums (title, album_artist_id, year) VALUES ('Album', ?, 1999)")
        .run(artist).lastInsertRowid
    )
    const insert = db.prepare(
      `INSERT INTO tracks (root_id, rel_path, mtime, size, duration_ms, codec, title, artist_id,
                           album_id, track_no, disc_no, genre, tag_year, play_count, last_played_at)
       VALUES (?, ?, 1, 1000, 180000, 'flac', ?, ?, ?, ?, 1, 'Ambient', 1999, ?, ?)`
    )
    const ids: number[] = []
    for (let i = 0; i < TRACKS; i += 1) {
      ids.push(
        Number(
          insert.run(
            root,
            `Artist/Album/${String(i).padStart(2, '0')}.flac`,
            `Track ${i}`,
            artist,
            album,
            i + 1,
            i,
            i === 1 ? Date.UTC(2026, 9, 1) : null
          ).lastInsertRowid
        )
      )
    }
    ;[overriddenId, plainId] = [ids[0]!, ids[1]!]
    new LibraryStore(db).setOverrides(
      [overriddenId],
      {
        title: 'Corrected Title',
        artist: 'Corrected Artist',
        album: 'Corrected Album',
        albumArtist: 'Corrected Album Artist',
        trackNo: 9,
        discNo: 2,
        year: 2001,
        genre: 'Techno'
      },
      Date.now()
    )
    db.prepare(
      `INSERT INTO track_tag_overrides (track_id, field, value, updated_at)
       VALUES (?, 'composer', '"Satie"', 1), (?, 'comment', 'null', 1)`
    ).run(overriddenId, overriddenId)
    db.exec(`CREATE VIEW leaky AS SELECT key, value FROM settings`)
    confined = openConfinedConnection(path)
  })

  afterAll(() => {
    confined?.close()
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (sql: string, rowCap = 1000): QueryResult => runQuery(confined, sql, rowCap)
  const rows = (sql: string, rowCap?: number): QueryRows => {
    const result = run(sql, rowCap)
    if (!result.ok) throw new Error(`${result.refusal}: ${result.message}`)
    return result
  }

  it('reads the views, with joins, CTEs, windows and JSON', () => {
    expect(rows('SELECT COUNT(*) FROM mcp_tracks').rows).toEqual([[TRACKS]])
    const joined = rows(
      `WITH a AS (SELECT id, name FROM mcp_artists)
       SELECT t.title, a.name, ROW_NUMBER() OVER (ORDER BY t.id) AS n
       FROM mcp_tracks t JOIN a ON a.id = t.artist_id WHERE t.id = ${plainId}`
    )
    expect(joined.columns).toEqual(['title', 'name', 'n'])
    expect(joined.rows).toEqual([['Track 1', 'Original Artist', 1]])
    expect(
      rows(
        `SELECT json_extract(staged_tags, '$.composer') FROM mcp_tracks WHERE id = ${overriddenId}`
      ).rows
    ).toEqual([['Satie']])
  })

  it('never exposes the root path', () => {
    const all = rows('SELECT * FROM mcp_tracks')
    expect(JSON.stringify(all)).not.toContain(ROOT_PATH)
    expect(all.rows[1]!.slice(1, 3)).toEqual(['Music', 'Artist/Album/01.flac'])
  })

  /**
   * The card's acceptance check: what an agent reads for an overridden track is
   * what the operator sees in the track list.
   */
  it('mcp_tracks equals the track list for an overridden track', () => {
    const [listed] = new LibraryStore(opened.db).getTracksByIds({ ids: [overriddenId] })
    const viewed = rows(
      `SELECT title, artist, album, album_artist, track_no, disc_no, year, play_count,
              duration_ms, codec, genre, track_year, has_corrections, staged_tags
       FROM mcp_tracks WHERE id = ${overriddenId}`
    ).rows[0]!
    expect(viewed.slice(0, 10)).toEqual([
      listed!.title,
      listed!.artist,
      listed!.album,
      listed!.albumArtist,
      listed!.trackNo,
      listed!.discNo,
      listed!.year,
      listed!.playCount,
      listed!.durationSec === null ? null : listed!.durationSec * 1000,
      listed!.codec
    ])
    expect(viewed.slice(0, 7)).toEqual([
      'Corrected Title',
      'Corrected Artist',
      'Corrected Album',
      'Corrected Album Artist',
      9,
      2,
      2001
    ])
    expect(viewed.slice(10, 13)).toEqual(['Techno', 2001, 1])
    expect(JSON.parse(viewed[13] as string)).toEqual({ composer: 'Satie', comment: null })
  })

  it('dates are ISO text and booleans are 0 or 1', () => {
    expect(
      rows(`SELECT last_played_at, favorite, has_corrections FROM mcp_tracks WHERE id = ${plainId}`)
        .rows
    ).toEqual([['2026-10-01T00:00:00.000Z', 0, 0]])
  })

  it.each([
    ['settings directly', 'SELECT * FROM settings'],
    ['a settings row count', 'SELECT COUNT(*) FROM settings'],
    [
      'settings in a subquery',
      "SELECT title FROM mcp_tracks WHERE (SELECT value FROM settings LIMIT 1) LIKE '%s%'"
    ],
    ['settings in a CTE', 'WITH s AS (SELECT * FROM settings) SELECT * FROM s'],
    [
      'settings in a CTE named like a real view',
      'WITH mcp_tracks AS (SELECT key, value FROM settings) SELECT * FROM mcp_tracks'
    ],
    ['settings through a non-mcp view', 'SELECT * FROM leaky'],
    ['settings in a join', 'SELECT t.id FROM mcp_tracks t JOIN settings s ON 1'],
    ['the root path', 'SELECT path FROM roots'],
    [
      'the root path through a CTE named like a view',
      'WITH mcp_albums AS (SELECT path FROM roots) SELECT * FROM mcp_albums'
    ],
    ['a base table', 'SELECT * FROM tracks'],
    ['the schema table', 'SELECT sql FROM sqlite_schema'],
    ['a pragma function', "SELECT * FROM pragma_table_info('settings')"]
  ])('confines %s', (_label, sql) => {
    const result = run(sql)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ refusal: 'not-authorized' })
    expect(JSON.stringify(result)).not.toContain('secret-session-key')
  })

  it.each([
    ['a second statement', 'SELECT 1; DELETE FROM playlists', 'multiple'],
    ['an empty statement', '-- nothing', 'empty'],
    [
      'an insert',
      "INSERT INTO playlists (name, position, created_at, updated_at) VALUES ('x', 0, 0, 0)",
      'not-authorized'
    ],
    ['an update', "UPDATE tracks SET title = 'x'", 'not-authorized'],
    ['a delete', 'DELETE FROM track_overrides', 'not-authorized'],
    ['DDL', 'CREATE TABLE x (a)', 'not-authorized'],
    ['a temp view', 'CREATE TEMP VIEW mcp_launder AS SELECT * FROM settings', 'not-authorized'],
    ['a drop', 'DROP VIEW mcp_tracks', 'not-authorized'],
    ['ATTACH', "ATTACH DATABASE ':memory:' AS other", 'not-authorized'],
    ['a pragma read', 'PRAGMA table_info(settings)', 'not-authorized'],
    ['a pragma write', 'PRAGMA query_only = OFF', 'not-authorized'],
    ['load_extension', "SELECT load_extension('x')", 'not-authorized'],
    ['a syntax error', 'SELEKT 1', 'sql-error']
  ])('refuses %s', (_label, sql, refusal) => {
    expect(run(sql)).toMatchObject({ ok: false, refusal })
  })

  it('refuses VACUUM INTO before it writes a file', () => {
    const target = join(dir, 'copy.db')
    const result = run(`VACUUM INTO '${target}'`)
    expect(result.ok).toBe(false)
    expect(['not-authorized', 'not-reader']).toContain((result as { refusal: string }).refusal)
    expect(existsSync(target)).toBe(false)
  })

  it('caps rows and says so', () => {
    const capped = rows('SELECT id FROM mcp_tracks ORDER BY id', 10)
    expect(capped.rows).toHaveLength(10)
    expect(capped.truncated).toBe(true)
    const exact = rows('SELECT id FROM mcp_tracks', TRACKS)
    expect(exact.rows).toHaveLength(TRACKS)
    expect(exact.truncated).toBe(false)
  })

  it('keeps big integers exact, describes blobs and clips long text', () => {
    const result = rows(
      `SELECT 9007199254740993 AS big, x'00ff' AS bytes, printf('%.3000c', 'a') AS wide`
    )
    expect(result.rows[0]!.slice(0, 2)).toEqual(['9007199254740993', '<blob: 2 bytes>'])
    expect((result.rows[0]![2] as string).length).toBe(2001)
    expect(result.clippedCells).toBe(1)
  })
})

describe('the query process', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let harness: QueryProcessHarness
  let host: QueryHost

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-query-host-'))
    const path = join(dir, 'library.db')
    opened = openDatabase(path)
    const { db } = opened
    const root = db
      .prepare("INSERT INTO roots (label, path, added_at) VALUES ('Music', '/abs', 1)")
      .run().lastInsertRowid
    const insert = db.prepare(
      'INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, ?, 1, 1, ?)'
    )
    db.transaction(() => {
      for (let i = 0; i < 400; i += 1) insert.run(root, `t${i}.flac`, `T${i}`)
    })()
    harness = await bundleQueryWorker()
    host = createQueryHost({ spawn: harness.spawn(path), timeoutMs: 1500 })
  })

  afterAll(async () => {
    host?.close()
    await harness?.dispose()
    opened.db.close()
    rmSync(dir, RM_RETRY)
  })

  it('answers from its own read-only connection', async () => {
    const result = await host.run('SELECT COUNT(*) AS n FROM mcp_tracks', 10)
    expect(result).toMatchObject({ ok: true, columns: ['n'], rows: [[400]] })
    expect(await host.run('SELECT * FROM settings', 10)).toMatchObject({
      ok: false,
      refusal: 'not-authorized'
    })
  })

  it('sees what main commits after it started', async () => {
    opened.db.prepare("UPDATE tracks SET title = 'Fresh' WHERE rel_path = 't0.flac'").run()
    expect(await host.run("SELECT title FROM mcp_tracks WHERE path = 't0.flac'", 10)).toMatchObject(
      { ok: true, rows: [['Fresh']] }
    )
  })

  it('kills a runaway cross join at the deadline while main keeps answering', async () => {
    // Warm, so spawn time is not part of what is measured.
    await host.run('SELECT 1', 1)
    const started = performance.now()
    const slow = host.run(
      'SELECT COUNT(*) FROM mcp_tracks a, mcp_tracks b, mcp_tracks c, mcp_tracks d',
      1
    )

    // Meanwhile, main's own connection and event loop: what an IPC call needs.
    const latencies: number[] = []
    const probe = opened.db.prepare('SELECT COUNT(*) AS n FROM tracks')
    for (let i = 0; i < 10; i += 1) {
      const before = performance.now()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect((probe.get() as { n: number }).n).toBe(400)
      latencies.push(performance.now() - before - 50)
    }
    expect(Math.max(...latencies)).toBeLessThan(250)

    const result = await slow
    const elapsed = performance.now() - started
    expect(result).toMatchObject({ ok: false, refusal: 'timeout' })
    expect(elapsed).toBeGreaterThanOrEqual(1400)
    expect(elapsed).toBeLessThan(5000)

    // Replaced: the next query gets a fresh process and an answer.
    expect(await host.run('SELECT COUNT(*) FROM mcp_tracks', 1)).toMatchObject({
      ok: true,
      rows: [[400]]
    })
    await waitFor(() => harness.alive() === 1)
  }, 20_000)

  it('runs queued queries one at a time, in order', async () => {
    const results = await Promise.all([
      host.run('SELECT 1', 1),
      host.run('SELECT 2', 1),
      host.run('SELECT 3', 1)
    ])
    expect(results.map((result) => (result as QueryRows).rows[0]![0])).toEqual([1, 2, 3])
  })

  it('answers unavailable once closed, and leaves no process behind', async () => {
    const closing = createQueryHost({ spawn: harness.spawn(join(dir, 'library.db')) })
    await closing.run('SELECT 1', 1)
    const before = harness.alive()
    closing.close()
    expect(await closing.run('SELECT 1', 1)).toMatchObject({ ok: false, refusal: 'unavailable' })
    await waitFor(() => harness.alive() === before - 1)
  })
})

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
