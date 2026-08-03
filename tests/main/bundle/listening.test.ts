import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { ListenStore } from '../../../src/main/listens/store'
import { exportListening, importListening } from '../../../src/main/bundle/listening'

/**
 * The D11 round trip for the listening section (W10-13).
 *
 * Two real databases through the real migration list, and the listens are
 * written by the real `ListenStore` rather than by an insert this file composes.
 * The claim under test is that two machines' libraries meet correctly, and every
 * shortcut here would be a third implementation of the thing being checked —
 * the same argument `rebuildCounters.test.ts` makes about full aggregation
 * versus incremental maintenance.
 *
 * The machines are called `source` and `target` throughout, never `a` and `b`,
 * because half of these assertions are about direction.
 */

interface Machine {
  dir: string
  db: Database.Database
  listens: ListenStore
}

const machines: Machine[] = []

function machine(): Machine {
  const dir = mkdtempSync(join(tmpdir(), 'fermata-test-'))
  const db = openDatabase(join(dir, 'library.db')).db
  const created = { dir, db, listens: new ListenStore(db) }
  machines.push(created)
  return created
}

function root(db: Database.Database, label: string, path: string): number {
  return Number(
    db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)').run(label, path, 0)
      .lastInsertRowid
  )
}

function artist(db: Database.Database, name: string): number {
  db.prepare('INSERT OR IGNORE INTO artists (name) VALUES (?)').run(name)
  return (db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as { id: number }).id
}

/**
 * One track, named the way the bundle will have to name it. `artistName` is
 * always given: `idx_listens_identity` does not collapse `NULL`s, and a suite
 * that dedupes untagged listens would be testing a promise 014 explicitly does
 * not make.
 */
function track(
  db: Database.Database,
  options: { rootId: number; relPath: string; title: string; artistName: string }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, duration_ms)
         VALUES (?, ?, 1, 2, ?, ?, 200000)`
      )
      .run(options.rootId, options.relPath, options.title, artist(db, options.artistName))
      .lastInsertRowid
  )
}

function listenCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM listens').get() as { n: number }).n
}

function listenIdentities(db: Database.Database): string[] {
  return (
    db
      .prepare('SELECT started_at AS startedAt, title AS title FROM listens ORDER BY started_at')
      .all() as { startedAt: number; title: string }[]
  ).map((row) => `${row.startedAt}:${row.title}`)
}

function counters(db: Database.Database, trackId: number): { plays: number; last: number | null } {
  const row = db
    .prepare('SELECT play_count AS plays, last_played_at AS last FROM tracks WHERE id = ?')
    .get(trackId) as { plays: number; last: number | null }
  return row
}

afterEach(() => {
  for (const created of machines.splice(0)) {
    created.db.close()
    rmSync(created.dir, { recursive: true, force: true })
  }
})

describe('exportListening', () => {
  it('names every track by root label and relative path, never by id', () => {
    const source = machine()
    const rootId = root(source.db, 'Music', '/home/one/Music')
    const trackId = track(source.db, {
      rootId,
      relPath: 'Bach/Goldberg/01 Aria.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId, startedAt: 1000, msListened: 90_000 })

    const section = exportListening(source.db)

    expect(section.listens).toHaveLength(1)
    expect(section.listens[0].track).toEqual({
      rootLabel: 'Music',
      relPath: 'Bach/Goldberg/01 Aria.flac'
    })
    expect(JSON.stringify(section)).not.toContain(`"trackId"`)
  })

  it('carries the snapshot columns and the listen genres', () => {
    const source = machine()
    const rootId = root(source.db, 'Music', '/home/one/Music')
    const trackId = track(source.db, {
      rootId,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.db
      .prepare('INSERT INTO track_genres (track_id, genre_key, genre) VALUES (?, ?, ?)')
      .run(trackId, 'baroque', 'Baroque')
    source.listens.commit({ trackId, startedAt: 1000, msListened: 90_000 })

    const [listen] = exportListening(source.db).listens

    expect(listen.title).toBe('Aria')
    expect(listen.artistName).toBe('Gould')
    expect(listen.msListened).toBe(90_000)
    expect(listen.genres).toEqual([{ key: 'baroque', genre: 'Baroque' }])
  })

  it('carries a listen whose track the exporting machine has already lost', () => {
    const source = machine()
    const rootId = root(source.db, 'Music', '/home/one/Music')
    const trackId = track(source.db, {
      rootId,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId, startedAt: 1000, msListened: 90_000 })
    source.db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

    const [listen] = exportListening(source.db).listens

    expect(listen.track).toBeNull()
    expect(listen.title).toBe('Aria')
  })
})

describe('importListening', () => {
  /**
   * The card's first case: two logs that genuinely overlap. Both machines hold
   * the 1000 listen — the same event, synced once before — and each holds one
   * the other does not.
   */
  it('interleaves two overlapping logs without duplicating the shared rows', () => {
    const source = machine()
    const target = machine()
    for (const m of [source, target]) {
      const rootId = root(m.db, 'Music', '/music')
      const trackId = track(m.db, {
        rootId,
        relPath: 'a.flac',
        title: 'Aria',
        artistName: 'Gould'
      })
      m.listens.commit({ trackId, startedAt: 1000, msListened: 90_000 })
    }
    const sourceTrack = (source.db.prepare('SELECT id FROM tracks LIMIT 1').get() as { id: number })
      .id
    const targetTrack = (target.db.prepare('SELECT id FROM tracks LIMIT 1').get() as { id: number })
      .id
    source.listens.commit({ trackId: sourceTrack, startedAt: 2000, msListened: 90_000 })
    target.listens.commit({ trackId: targetTrack, startedAt: 3000, msListened: 90_000 })

    const result = importListening(target.db, exportListening(source.db))

    expect(result.listensInserted).toBe(1)
    expect(result.listensAlreadyHeld).toBe(1)
    expect(listenIdentities(target.db)).toEqual(['1000:Aria', '2000:Aria', '3000:Aria'])
  })

  it('recomputes play_count from the merged log rather than adding the two', () => {
    const source = machine()
    const target = machine()
    for (const m of [source, target]) {
      const rootId = root(m.db, 'Music', '/music')
      const trackId = track(m.db, {
        rootId,
        relPath: 'a.flac',
        title: 'Aria',
        artistName: 'Gould'
      })
      m.listens.commit({ trackId, startedAt: 1000, msListened: 90_000 })
    }
    const sourceTrack = (source.db.prepare('SELECT id FROM tracks LIMIT 1').get() as { id: number })
      .id
    const targetTrack = (target.db.prepare('SELECT id FROM tracks LIMIT 1').get() as { id: number })
      .id
    source.listens.commit({ trackId: sourceTrack, startedAt: 2000, msListened: 90_000 })
    target.listens.commit({ trackId: targetTrack, startedAt: 3000, msListened: 90_000 })
    expect(counters(target.db, targetTrack).plays).toBe(2)

    importListening(target.db, exportListening(source.db))

    // Three listens, not four: the shared 1000 is one event, and 2 + 2 is the
    // number this rule exists to refuse.
    expect(counters(target.db, targetTrack)).toEqual({ plays: 3, last: 3000 })
  })

  it('changes nothing when the same bundle is imported twice', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId: sourceTrack, startedAt: 1000, msListened: 90_000 })
    source.db
      .prepare('INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, ?)')
      .run(sourceTrack, 5000)
    const targetRoot = root(target.db, 'Music', '/music')
    const targetTrack = track(target.db, {
      rootId: targetRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })

    const section = exportListening(source.db)
    importListening(target.db, section)
    const afterFirst = {
      listens: listenIdentities(target.db),
      genres: target.db.prepare('SELECT COUNT(*) AS n FROM listen_genres').get(),
      favorites: target.db.prepare('SELECT * FROM track_favorites ORDER BY track_id').all(),
      counters: counters(target.db, targetTrack)
    }

    const second = importListening(target.db, section)

    expect(second.listensInserted).toBe(0)
    expect(second.listensAlreadyHeld).toBe(1)
    expect(second.counters.tracksChanged).toBe(0)
    expect({
      listens: listenIdentities(target.db),
      genres: target.db.prepare('SELECT COUNT(*) AS n FROM listen_genres').get(),
      favorites: target.db.prepare('SELECT * FROM track_favorites ORDER BY track_id').all(),
      counters: counters(target.db, targetTrack)
    }).toEqual(afterFirst)
  })

  /**
   * The card's second case. The other machine keeps its music under a root it
   * calls something else, which is the layout D11's relative paths were chosen
   * for — and the listens have to arrive whole either way, because their meaning
   * is in the snapshot columns and not in the reference.
   */
  it('imports listens intact from a machine with a different root layout', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/home/one/Music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'Bach/01 Aria.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId: sourceTrack, startedAt: 1000, msListened: 90_000 })

    const targetRoot = root(target.db, 'NAS', '/mnt/media/audio')
    const targetTrack = track(target.db, {
      rootId: targetRoot,
      relPath: 'Bach/01 Aria.flac',
      title: 'Aria',
      artistName: 'Gould'
    })

    const result = importListening(target.db, exportListening(source.db))

    expect(result.listensInserted).toBe(1)
    expect(result.listensUnlinked).toBe(0)
    expect(counters(target.db, targetTrack)).toEqual({ plays: 1, last: 1000 })
  })

  it('keeps a listen whose track this machine does not have, unlinked', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'only-on-source.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId: sourceTrack, startedAt: 1000, msListened: 90_000 })
    root(target.db, 'Music', '/music')

    const result = importListening(target.db, exportListening(source.db))

    expect(result.listensInserted).toBe(1)
    expect(result.listensUnlinked).toBe(1)
    expect(listenCount(target.db)).toBe(1)
    expect(target.db.prepare('SELECT track_id AS trackId, title FROM listens').get()).toEqual({
      trackId: null,
      title: 'Aria'
    })
  })

  it('refuses to guess when two roots hold the same relative path', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId: sourceTrack, startedAt: 1000, msListened: 90_000 })

    // Neither is labelled `Music`, so the label pass misses and the fallback
    // finds two candidates.
    for (const label of ['Archive', 'NAS']) {
      const rootId = root(target.db, label, `/mnt/${label}`)
      track(target.db, { rootId, relPath: 'a.flac', title: 'Aria', artistName: 'Gould' })
    }

    const result = importListening(target.db, exportListening(source.db))

    expect(result.listensUnlinked).toBe(1)
    expect(listenCount(target.db)).toBe(1)
    expect(
      target.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE play_count > 0').get()
    ).toEqual({ n: 0 })
  })
})

describe('importListening — favorites', () => {
  it('carries a favorite across, resolved by root label and path', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.db
      .prepare('INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, ?)')
      .run(sourceTrack, 7000)
    const targetRoot = root(target.db, 'Music', '/music')
    const targetTrack = track(target.db, {
      rootId: targetRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })

    const result = importListening(target.db, exportListening(source.db))

    expect(result.favoritesApplied).toBe(1)
    expect(
      target.db
        .prepare('SELECT favorited_at AS at FROM track_favorites WHERE track_id = ?')
        .get(targetTrack)
    ).toEqual({ at: 7000 })
  })

  it('resolves a favorite by recency, whichever direction the bundle travels', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.db
      .prepare('INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, ?)')
      .run(sourceTrack, 3000)
    const targetRoot = root(target.db, 'Music', '/music')
    const targetTrack = track(target.db, {
      rootId: targetRoot,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    target.db
      .prepare('INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, ?)')
      .run(targetTrack, 9000)

    importListening(target.db, exportListening(source.db))

    expect(
      target.db
        .prepare('SELECT favorited_at AS at FROM track_favorites WHERE track_id = ?')
        .get(targetTrack)
    ).toEqual({ at: 9000 })
  })

  it('counts a favorite naming a track this machine does not have, and writes nothing', () => {
    const source = machine()
    const target = machine()
    const sourceRoot = root(source.db, 'Music', '/music')
    const sourceTrack = track(source.db, {
      rootId: sourceRoot,
      relPath: 'only-on-source.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.db
      .prepare('INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, ?)')
      .run(sourceTrack, 7000)
    root(target.db, 'Music', '/music')

    const result = importListening(target.db, exportListening(source.db))

    expect(result.favoritesUnresolved).toBe(1)
    expect(result.favoritesApplied).toBe(0)
    expect(target.db.prepare('SELECT COUNT(*) AS n FROM track_favorites').get()).toEqual({ n: 0 })
  })
})

describe('what the section does not carry', () => {
  it('leaves the play-history trail and the scrobble outbox out of the payload', () => {
    const source = machine()
    const rootId = root(source.db, 'Music', '/music')
    const trackId = track(source.db, {
      rootId,
      relPath: 'a.flac',
      title: 'Aria',
      artistName: 'Gould'
    })
    source.listens.commit({ trackId, startedAt: 1000, msListened: 90_000 })

    const section = exportListening(source.db)

    expect(Object.keys(section).sort()).toEqual(['favorites', 'listens'])
  })
})
