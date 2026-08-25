import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqlitePlayHistoryService } from '../../../src/main/history/service'
import { PLAY_HISTORY_CAP } from '../../../src/shared/history'

/**
 * The play-history trail, driven through the real migration list against a real
 * SQLite file.
 *
 * A temp file rather than `:memory:` because two of the claims are about the
 * database outliving the process that wrote it: history survives a restart, and
 * the cap is a property of the table rather than of a cache in front of it.
 */

let dir: string
let file: string
let db: Database.Database

function open(): Database.Database {
  return openDatabase(file).db
}

/** One root and `count` tracks under it, returning their ids in order. */
function seedTracks(target: Database.Database, count: number): number[] {
  const rootId = Number(
    target
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 0).lastInsertRowid
  )
  const insert = target.prepare(
    'INSERT INTO tracks (root_id, rel_path, mtime, size, title) VALUES (?, ?, 1, 2, ?)'
  )
  return Array.from({ length: count }, (_, index) =>
    Number(insert.run(rootId, `t${index}.flac`, `Track ${index}`).lastInsertRowid)
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-history-'))
  file = join(dir, 'library.db')
  db = open()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the play-history migration', () => {
  it('adds the table and its cascade index to an existing library', () => {
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('play_history')
    ).toEqual({ name: 'play_history' })
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_play_history_track')
    ).toEqual({ name: 'idx_play_history_track' })
  })

  it('takes a row with its track when the file leaves the library', async () => {
    const [trackId] = seedTracks(db, 1)
    const history = new SqlitePlayHistoryService({ db })
    await history.record(trackId!)
    expect(await history.list({ limit: 10 })).toHaveLength(1)

    // What a rescan does when the file is gone from the root.
    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

    // Not merely hidden by the join — the row itself is gone, which is what
    // `ON DELETE CASCADE` buys over filtering on read.
    expect(db.prepare('SELECT COUNT(*) AS n FROM play_history').get()).toEqual({ n: 0 })
    expect(await history.list({ limit: 10 })).toEqual([])
  })
})

describe('recording a play', () => {
  it('returns the joined display row, not just an id', async () => {
    const [trackId] = seedTracks(db, 1)
    const history = new SqlitePlayHistoryService({ db, now: () => 1_700_000_000_000 })

    const entry = await history.record(trackId!)

    expect(entry).not.toBeNull()
    expect(entry!.playedAt).toBe(1_700_000_000_000)
    expect(entry!.track.id).toBe(trackId)
    expect(entry!.track.title).toBe('Track 0')
    // The trail renders artwork like every other list, so the projection has to
    // carry it — this is the assertion that catches `TRACK_PROJECTION` drifting.
    expect(entry!.track.artwork.small).toContain('oscine://artwork/')
  })

  it('resolves null for a track that is no longer in the library', async () => {
    const history = new SqlitePlayHistoryService({ db })

    // The race: a rescan removed the file while it was still audible. Not a
    // constraint error, because the play genuinely happened.
    await expect(history.record(9999)).resolves.toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM play_history').get()).toEqual({ n: 0 })
  })

  it('appends rather than collapsing repeats — the trail is append-only', async () => {
    const [trackId] = seedTracks(db, 1)
    let clock = 1000
    const history = new SqlitePlayHistoryService({ db, now: () => (clock += 1000) })

    await history.record(trackId!)
    await history.record(trackId!)
    await history.record(trackId!)

    // Three rows, three times. Collapsing consecutive replays is the *pane's*
    // job (`buildTrailRows`); the store records what happened.
    const trail = await history.list({ limit: 10 })
    expect(trail).toHaveLength(3)
    expect(trail.map((entry) => entry.playedAt)).toEqual([4000, 3000, 2000])
  })

  it('orders by row id, not by a clock that went backwards', async () => {
    const [first, second] = seedTracks(db, 2)
    const clock = [5000, 1000]
    let call = 0
    const history = new SqlitePlayHistoryService({ db, now: () => clock[call++]! })

    await history.record(first!)
    await history.record(second!)

    // An NTP correction between the two plays. The second one still happened
    // second, and the trail says so — `playedAt` is displayed, never sorted on.
    const trail = await history.list({ limit: 10 })
    expect(trail.map((entry) => entry.track.id)).toEqual([second, first])
    expect(trail.map((entry) => entry.playedAt)).toEqual([1000, 5000])
  })
})

describe('the cap', () => {
  it('keeps the newest `cap` plays and evicts the rest on write', async () => {
    const ids = seedTracks(db, 6)
    const history = new SqlitePlayHistoryService({ db, cap: 3 })

    for (const id of ids) await history.record(id)

    const trail = await history.list({ limit: 100 })
    expect(trail).toHaveLength(3)
    expect(trail.map((entry) => entry.track.id)).toEqual([ids[5], ids[4], ids[3]])
    // Evicted from the table, not merely from the response.
    expect(db.prepare('SELECT COUNT(*) AS n FROM play_history').get()).toEqual({ n: 3 })
  })

  it('does not evict anything while the trail is under the cap', async () => {
    const ids = seedTracks(db, 3)
    const history = new SqlitePlayHistoryService({ db, cap: 10 })

    for (const id of ids) await history.record(id)

    // The eviction bound goes negative here; the statement must match nothing
    // rather than, say, deleting the row it just wrote.
    expect(await history.list({ limit: 100 })).toHaveLength(3)
  })

  it('clamps a request above the cap instead of serving it', async () => {
    const ids = seedTracks(db, 4)
    const history = new SqlitePlayHistoryService({ db, cap: 2 })
    for (const id of ids) await history.record(id)

    expect(await history.list({ limit: PLAY_HISTORY_CAP })).toHaveLength(2)
  })

  it('serves nothing for a limit of zero', async () => {
    const [trackId] = seedTracks(db, 1)
    const history = new SqlitePlayHistoryService({ db })
    await history.record(trackId!)

    expect(await history.list({ limit: 0 })).toEqual([])
  })
})

describe('across a restart', () => {
  it('keeps the trail, in order, when the database is reopened', async () => {
    const ids = seedTracks(db, 3)
    let clock = 0
    const before = new SqlitePlayHistoryService({ db, now: () => (clock += 100) })
    for (const id of ids) await before.record(id)
    db.close()

    // A second launch: a fresh connection over the same file, through the real
    // migration runner, which must find nothing left to do.
    db = open()
    const after = new SqlitePlayHistoryService({ db })

    const trail = await after.list({ limit: 10 })
    expect(trail.map((entry) => entry.track.id)).toEqual([ids[2], ids[1], ids[0]])
    expect(trail.map((entry) => entry.playedAt)).toEqual([300, 200, 100])
  })
})

describe('clearing', () => {
  it('empties the trail and leaves the tracks alone', async () => {
    const ids = seedTracks(db, 3)
    const history = new SqlitePlayHistoryService({ db })
    for (const id of ids) await history.record(id)

    await history.clear()

    expect(await history.list({ limit: 10 })).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM tracks').get()).toEqual({ n: 3 })
  })

  it('records again cleanly afterwards', async () => {
    const ids = seedTracks(db, 2)
    const history = new SqlitePlayHistoryService({ db })
    await history.record(ids[0]!)
    await history.clear()

    const entry = await history.record(ids[1]!)
    expect(entry?.track.id).toBe(ids[1])
    expect(await history.list({ limit: 10 })).toHaveLength(1)
  })
})
