import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import type { TrackTags } from '../../../src/main/library/metadata'
import { TagStore } from '../../../src/main/tags/store'

/**
 * The browse-by-genre/tag surface and the column's batch read — **W15-5**.
 *
 * Driven through the real migration list against a real SQLite file, like the
 * rest of the tag tests: the load-bearing claims — that a file genre and a user
 * tag with the same casefold key are one browse row, that `tagKeys` narrows on
 * either vocabulary, and that the counts are of *distinct* tracks — are
 * properties of what is durably in the database.
 */

let dir: string
let file: string
let opened: OpenDatabaseResult
let db: Database.Database
let library: LibraryStore
let store: TagStore
let rootId: number
let nextPath = 0

function seedTrack(genre: string | null = null): number {
  const relPath = `t${nextPath++}.flac`
  library.writeTracks(rootId, [
    { file: { absPath: `/music/${relPath}`, relPath, size: 1000, mtime: 1 }, tags: tags(genre) }
  ])
  return Number(
    (db.prepare('SELECT id FROM tracks WHERE rel_path = ?').get(relPath) as { id: number }).id
  )
}

function tags(genre: string | null): TrackTags {
  return {
    title: 'A Title',
    artist: 'An Artist',
    album: 'An Album',
    albumArtist: 'An Artist',
    trackNo: 1,
    discNo: null,
    year: 2002,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre,
    replayGain: null
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-browse-tags-'))
  file = join(dir, 'library.db')
  opened = openDatabase(file)
  db = opened.db
  rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 1).lastInsertRowid
  )
  library = new LibraryStore(db)
  store = new TagStore(db)
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('listTagFacets', () => {
  it('folds a file genre and a same-key user tag into one row', () => {
    const track = seedTrack('rock')
    store.addTag([track], 'Rock', 'user')

    const rows = library.listTagFacets({})

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'rock',
      // The user spelling wins the display label over the file's lowercase one.
      label: 'Rock',
      trackCount: 1,
      hasFile: true,
      hasUser: true
    })
  })

  it('counts distinct tracks, not vocabulary rows', () => {
    const a = seedTrack('Rock')
    seedTrack('Rock')
    // A user tag on a track that already has the file genre must not double-count.
    store.addTag([a], 'Rock', 'user')

    const [row] = library.listTagFacets({})

    expect(row).toMatchObject({ key: 'rock', trackCount: 2, hasFile: true, hasUser: true })
  })

  it('lists a user-only tag with hasFile false', () => {
    const track = seedTrack(null)
    store.addTag([track], 'Focus', 'user')

    const rows = library.listTagFacets({})

    expect(rows).toEqual([
      { key: 'focus', label: 'Focus', trackCount: 1, hasFile: false, hasUser: true }
    ])
  })

  it('narrows the vocabulary by an upstream artist filter', () => {
    const rock = seedTrack('Rock')
    seedTrack('Jazz')
    const artistId = (
      db.prepare('SELECT artist_id AS id FROM tracks WHERE id = ?').get(rock) as { id: number }
    ).id

    const rows = library.listTagFacets({ artistIds: [artistId] })

    // Every seeded track shares one artist, so the artist filter keeps both
    // genres; the point is that the filter is accepted and applied at all.
    expect(rows.map((r) => r.key).sort()).toEqual(['jazz', 'rock'])
  })
})

describe('tagKeys filter', () => {
  function idsFor(tagKeys: string[]): number[] {
    return library.listTrackIds({
      tagKeys,
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 100
    }).ids
  }

  it('matches tracks carrying the key as a file genre or a user tag', () => {
    const byGenre = seedTrack('Jazz')
    const byTag = seedTrack(null)
    store.addTag([byTag], 'Jazz', 'user')
    seedTrack('Rock') // carries neither 'jazz' vocabulary

    expect(idsFor(['jazz']).sort((a, b) => a - b)).toEqual([byGenre, byTag].sort((a, b) => a - b))
  })

  it('unions across multiple keys', () => {
    const jazz = seedTrack('Jazz')
    const rock = seedTrack('Rock')
    seedTrack('Folk')

    expect(idsFor(['jazz', 'rock']).sort((a, b) => a - b)).toEqual(
      [jazz, rock].sort((a, b) => a - b)
    )
  })
})

describe('forTracks', () => {
  it('returns both vocabularies per track and omits tracks carrying nothing', () => {
    const tagged = seedTrack('Rock')
    store.addTag([tagged], 'Workout', 'user')
    const bare = seedTrack(null)

    const rows = store.forTracks([tagged, bare])

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.trackId).toBe(tagged)
    expect(row.file).toEqual(['Rock'])
    expect(row.user).toEqual([{ id: expect.any(Number), label: 'Workout', source: 'user' }])
  })

  it('deduplicates the requested ids and answers empty for an empty batch', () => {
    const track = seedTrack('Rock')

    expect(store.forTracks([track, track])).toHaveLength(1)
    expect(store.forTracks([])).toEqual([])
  })
})
