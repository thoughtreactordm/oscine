import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqliteListenService } from '../../../src/main/listens/service'
import { rebuildTrackCounters } from '../../../src/main/stats/counters'

/**
 * `stats.rebuildCounters` — the counter rebuild (W10-5).
 *
 * Against a real database through the real migration list, like the listen
 * commit's tests, and for one reason above the others: the claim under test is
 * that a full aggregation and the incremental maintenance agree. Two
 * implementations of the same number are exactly the thing a fake cannot check,
 * because a fake would be a third.
 */

let dir: string
let file: string
let db: Database.Database

let nextPath = 0

function rootId(): number {
  const existing = db.prepare('SELECT id FROM roots LIMIT 1').get() as { id: number } | undefined
  if (existing) return existing.id
  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 0).lastInsertRowid
  )
}

/** One track with a title, which is all the commit needs to attribute a listen. */
function seedTrack(title = `Song ${nextPath}`): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, duration_ms)
         VALUES (?, ?, 1, 2, ?, 200000)`
      )
      .run(rootId(), `t${nextPath++}.flac`, title).lastInsertRowid
  )
}

function counters(trackId: number): { play_count: number; last_played_at: number | null } {
  return db.prepare('SELECT play_count, last_played_at FROM tracks WHERE id = ?').get(trackId) as {
    play_count: number
    last_played_at: number | null
  }
}

function everyCounter(): Array<{ id: number; play_count: number; last_played_at: number | null }> {
  return db
    .prepare('SELECT id, play_count, last_played_at FROM tracks ORDER BY id')
    .all() as Array<{
    id: number
    play_count: number
    last_played_at: number | null
  }>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-counters-'))
  file = join(dir, 'library.db')
  db = openDatabase(file).db
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('rebuildTrackCounters', () => {
  /**
   * The load-bearing test, and the reason the whole design is allowed to call
   * these columns caches.
   *
   * A few thousand listens across a few hundred tracks, committed through the
   * real service so that the incremental path writes them, then recomputed from
   * scratch. Nothing may move. If it does, the maintained value was wrong and
   * every chart built on it was wrong too — and the log, which wins, is what
   * says so.
   *
   * The timestamps deliberately do not ascend with the loop. `last_played_at` is
   * maintained with `MAX`, and a run of listens in chronological order would
   * pass whether it were `MAX` or a bare assignment. This one would not.
   */
  it('reproduces incrementally-maintained values exactly', async () => {
    const listens = new SqliteListenService({ db })
    const tracks = Array.from({ length: 300 }, () => seedTrack())

    for (let i = 0; i < 3_000; i++) {
      const trackId = tracks[(i * 7) % tracks.length]!
      // Pseudo-random but fixed: a scattered clock without a seeded generator,
      // and reproducible, which a real one would not be.
      const startedAt = 1_700_000_000_000 + ((i * 104_729) % 5_000_000) * 1_000
      await listens.record({ trackId, startedAt, msListened: 120_000 })
    }

    const maintained = everyCounter()
    // The maintenance actually happened — otherwise this test proves that two
    // ways of computing zero agree.
    expect(maintained.some((row) => row.play_count > 0)).toBe(true)
    expect(maintained.some((row) => row.last_played_at !== null)).toBe(true)

    const result = rebuildTrackCounters(db)

    expect(everyCounter()).toEqual(maintained)
    expect(result.tracksChanged).toBe(0)
    expect(result.tracksScanned).toBe(tracks.length)
    expect(result.listensCounted).toBe(
      (db.prepare('SELECT COUNT(*) AS n FROM listens').get() as { n: number }).n
    )
  })

  /**
   * 014's `ON DELETE SET NULL`: a track that left the library leaves its listens
   * behind, orphaned. They are still listens and every dashboard still counts
   * them; they are simply attributable to no row in `tracks`.
   *
   * The track that replaces it must therefore rebuild to zero rather than
   * inheriting them, and the rebuild must not fail on the null.
   */
  it('gives a track whose listens are all orphaned a play count of zero', async () => {
    const listens = new SqliteListenService({ db })
    const doomed = seedTrack('Doomed')
    await listens.record({ trackId: doomed, startedAt: 1_000, msListened: 90_000 })
    await listens.record({ trackId: doomed, startedAt: 2_000, msListened: 90_000 })

    db.prepare('DELETE FROM tracks WHERE id = ?').run(doomed)
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM listens WHERE track_id IS NULL').get() as {
          n: number
        }
      ).n
    ).toBe(2)

    const survivor = seedTrack('Survivor')
    // Drift the survivor by hand, so the rebuild has something to correct
    // rather than a column that was already zero.
    db.prepare('UPDATE tracks SET play_count = 9, last_played_at = 5000 WHERE id = ?').run(survivor)

    const result = rebuildTrackCounters(db)

    expect(counters(survivor)).toEqual({ play_count: 0, last_played_at: null })
    expect(result.tracksChanged).toBe(1)
    // The orphans were counted as listens even though they belong to no track.
    expect(result.listensCounted).toBe(2)
  })

  /** A repair that is not idempotent is a repair nobody can safely run twice. */
  it('is idempotent', async () => {
    const listens = new SqliteListenService({ db })
    const a = seedTrack('A')
    const b = seedTrack('B')
    await listens.record({ trackId: a, startedAt: 10_000, msListened: 90_000 })
    await listens.record({ trackId: b, startedAt: 20_000, msListened: 90_000 })
    await listens.record({ trackId: a, startedAt: 30_000, msListened: 90_000 })

    db.prepare('UPDATE tracks SET play_count = 0, last_played_at = NULL').run()

    const first = rebuildTrackCounters(db)
    const afterFirst = everyCounter()
    const second = rebuildTrackCounters(db)

    expect(first.tracksChanged).toBe(2)
    expect(everyCounter()).toEqual(afterFirst)
    expect(second.tracksChanged).toBe(0)
    expect(counters(a)).toEqual({ play_count: 2, last_played_at: 30_000 })
    expect(counters(b)).toEqual({ play_count: 1, last_played_at: 20_000 })
  })

  /**
   * The log wins, without argument — including when the log is empty.
   *
   * The tempting cheap implementation groups `listens` and joins the result back
   * onto `tracks`, which leaves a track with no listens untouched: over an empty
   * log it would report success and change nothing, and the stale counters it
   * was run to clear would still be there.
   */
  it('zeroes every track when the log is empty', () => {
    const a = seedTrack('A')
    const b = seedTrack('B')
    db.prepare('UPDATE tracks SET play_count = 41, last_played_at = 99000').run()

    const result = rebuildTrackCounters(db)

    expect(counters(a)).toEqual({ play_count: 0, last_played_at: null })
    expect(counters(b)).toEqual({ play_count: 0, last_played_at: null })
    expect(result).toEqual({ tracksChanged: 2, tracksScanned: 2, listensCounted: 0 })
  })

  /** Nothing to scan is not an error, and reports itself as nothing. */
  it('reports an empty library rather than failing on it', () => {
    expect(rebuildTrackCounters(db)).toEqual({
      tracksChanged: 0,
      tracksScanned: 0,
      listensCounted: 0
    })
  })
})
