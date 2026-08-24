import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import type { TrackTags } from '../../../src/main/library/metadata'

/**
 * D25's invariant, from the writer's side: `indexed_at` is the arrival clock the
 * scanner stamps on the first insert of a `(root_id, rel_path)` and never touches
 * again. The upsert omits it from its `UPDATE` set, so a rescan — which does move
 * `mtime` — leaves the arrival stamp exactly where it was. Stamped once, never on
 * rescan.
 */

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-indexed-'))
  file = join(dir, 'library.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tags(): TrackTags {
  return {
    title: 'Roygbiv',
    artist: 'Boards of Canada',
    album: 'Music Has the Right to Children',
    albumArtist: 'Boards of Canada',
    trackNo: 1,
    discNo: null,
    year: 1998,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: null,
    replayGain: null
  }
}

function scanned(
  relPath: string,
  mtime: number
): {
  file: { absPath: string; relPath: string; size: number; mtime: number }
  tags: TrackTags
} {
  return { file: { absPath: `/music/${relPath}`, relPath, size: 1000, mtime }, tags: tags() }
}

function addRoot(db: Database.Database): number {
  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 1).lastInsertRowid
  )
}

describe('indexed_at, stamped by the scanner', () => {
  let opened: OpenDatabaseResult
  let store: LibraryStore
  let rootId: number

  beforeEach(() => {
    opened = openDatabase(file)
    rootId = addRoot(opened.db)
    store = new LibraryStore(opened.db)
  })

  afterEach(() => {
    opened.db.close()
  })

  const row = (relPath: string): { indexedAt: number; mtime: number } =>
    opened.db
      .prepare(
        'SELECT indexed_at AS indexedAt, mtime FROM tracks WHERE root_id = ? AND rel_path = ?'
      )
      .get(rootId, relPath) as { indexedAt: number; mtime: number }

  it('stamps the first insert with the arrival timestamp it is given', () => {
    store.writeTracks(rootId, [scanned('a.flac', 10)], 111_000)

    expect(row('a.flac')).toEqual({ indexedAt: 111_000, mtime: 10 })
  })

  it('leaves indexed_at untouched on a rescan, while mtime moves', () => {
    store.writeTracks(rootId, [scanned('a.flac', 10)], 111_000)
    // The same file, retagged: a later mtime and a later scan, same row.
    store.writeTracks(rootId, [scanned('a.flac', 999)], 222_000)

    // The rescan is not an arrival: the stamp is the first one, not the second.
    expect(row('a.flac')).toEqual({ indexedAt: 111_000, mtime: 999 })
  })

  it('stamps every row of one scan with that scan single timestamp', () => {
    store.writeTracks(rootId, [scanned('a.flac', 10), scanned('b.flac', 20)], 111_000)

    expect(row('a.flac').indexedAt).toBe(111_000)
    expect(row('b.flac').indexedAt).toBe(111_000)
  })
})
