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
 * User tags — the app-side layer over the library (W15-1, migration 018, D7).
 *
 * Driven through the real migration list against a real SQLite file, like the
 * favorites and genre tests and for the same reasons: the claims are about what
 * is durably in the database, and the load-bearing ones — the shared casefold,
 * the cascade, and above all that a rescan leaves user tags untouched — are
 * properties a fake would simply not have.
 */

let dir: string
let file: string
let opened: OpenDatabaseResult
let db: Database.Database
let library: LibraryStore
let store: TagStore
let rootId: number
let nextPath = 0

/** One track under a shared root, with an optional file genre for the `file` half. */
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

/** Re-run the scanner over one track's path with a (possibly new) genre. */
function rescan(trackRelPathIndex: number, genre: string | null): void {
  const relPath = `t${trackRelPathIndex}.flac`
  library.writeTracks(rootId, [
    { file: { absPath: `/music/${relPath}`, relPath, size: 1000, mtime: 2 }, tags: tags(genre) }
  ])
}

function tagRowCount(): number {
  return (db.prepare('SELECT count(*) AS n FROM tags').get() as { n: number }).n
}

function joinRowCount(): number {
  return (db.prepare('SELECT count(*) AS n FROM track_tags').get() as { n: number }).n
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-tags-'))
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

describe('addTag', () => {
  it('coins a vocabulary row and assigns it, returning the tag', () => {
    const track = seedTrack()

    const tag = store.addTag([track], 'Workout', 'user')

    expect(tag).toMatchObject({ key: 'workout', label: 'Workout' })
    expect(store.tagsForTrack(track).user).toEqual([
      { id: tag!.id, label: 'Workout', source: 'user' }
    ])
  })

  it('reuses one vocabulary row across casefold-equal spellings', () => {
    const a = seedTrack()
    const b = seedTrack()

    const first = store.addTag([a], 'Hip-Hop', 'user')
    const second = store.addTag([b], 'HIP-HOP', 'user')

    expect(second!.id).toBe(first!.id)
    expect(tagRowCount()).toBe(1)
    // First spelling wins: the second, differently-cased apply does not respell it.
    expect(first!.label).toBe('Hip-Hop')
    expect(second!.label).toBe('Hip-Hop')
  })

  it('does not split a label the way a file genre is split', () => {
    const track = seedTrack()

    const tag = store.addTag([track], 'Rock/Pop', 'user')

    expect(tag).toMatchObject({ key: 'rock/pop', label: 'Rock/Pop' })
    expect(store.tagsForTrack(track).user).toHaveLength(1)
  })

  it('applies to a whole batch in one call', () => {
    const a = seedTrack()
    const b = seedTrack()
    const c = seedTrack()

    store.addTag([a, b, c], 'Live', 'user')

    expect(joinRowCount()).toBe(3)
    expect(store.listTags()).toEqual([
      expect.objectContaining({ key: 'live', label: 'Live', trackCount: 3 })
    ])
  })

  it('dedupes ids and is idempotent on re-apply', () => {
    const track = seedTrack()

    store.addTag([track, track], 'Chill', 'user')
    store.addTag([track], 'Chill', 'user')

    expect(joinRowCount()).toBe(1)
  })

  it('does not assign to a track that is not in the library', () => {
    const tag = store.addTag([9999], 'Ghost', 'user')

    // The vocabulary row is coined, but nothing is assigned.
    expect(tag).not.toBeNull()
    expect(joinRowCount()).toBe(0)
  })

  it('promotes a suggested assignment to user, never the reverse', () => {
    const track = seedTrack()

    store.addTag([track], 'Ambient', 'suggested')
    expect(store.tagsForTrack(track).user[0].source).toBe('suggested')

    store.addTag([track], 'Ambient', 'user')
    expect(store.tagsForTrack(track).user[0].source).toBe('user')

    // Re-running the suggestion pass does not demote it.
    store.addTag([track], 'Ambient', 'suggested')
    expect(store.tagsForTrack(track).user[0].source).toBe('user')
  })

  it('returns null for a label that normalises to nothing', () => {
    const track = seedTrack()

    expect(store.addTag([track], '   ', 'user')).toBeNull()
    expect(tagRowCount()).toBe(0)
  })
})

describe('tagsForTrack', () => {
  it('keeps file genres and user tags apart', () => {
    const track = seedTrack('Rock; Alternative')
    store.addTag([track], 'Favourite', 'user')

    expect(store.tagsForTrack(track)).toEqual({
      file: ['Alternative', 'Rock'],
      user: [{ id: expect.any(Number), label: 'Favourite', source: 'user' }]
    })
  })

  it('returns two empty lists for a track with no tags and for an absent track', () => {
    const track = seedTrack()

    expect(store.tagsForTrack(track)).toEqual({ file: [], user: [] })
    expect(store.tagsForTrack(9999)).toEqual({ file: [], user: [] })
  })
})

describe('removeTag', () => {
  it('removes an assignment and prunes the tag it empties', () => {
    const track = seedTrack()
    const tag = store.addTag([track], 'Temporary', 'user')!

    const result = store.removeTag([track], tag.id)

    expect(result).toEqual({ removed: 1, pruned: true })
    expect(store.tagsForTrack(track).user).toEqual([])
    expect(tagRowCount()).toBe(0)
  })

  it('keeps the vocabulary while other tracks still carry the tag', () => {
    const a = seedTrack()
    const b = seedTrack()
    const tag = store.addTag([a, b], 'Shared', 'user')!

    const result = store.removeTag([a], tag.id)

    expect(result).toEqual({ removed: 1, pruned: false })
    expect(store.listTags()).toEqual([expect.objectContaining({ id: tag.id, trackCount: 1 })])
  })

  it('reports zero and prunes nothing for a tag not on those tracks', () => {
    const a = seedTrack()
    const b = seedTrack()
    const tag = store.addTag([a], 'OnA', 'user')!

    expect(store.removeTag([b], tag.id)).toEqual({ removed: 0, pruned: false })
    expect(tagRowCount()).toBe(1)
  })
})

describe('renameTag', () => {
  it('respells a tag without moving its identity', () => {
    const track = seedTrack()
    const tag = store.addTag([track], 'hiphop', 'user')!

    const renamed = store.renameTag(tag.id, 'HipHop')

    expect(renamed).toEqual({ id: tag.id, key: 'hiphop', label: 'HipHop' })
    expect(tagRowCount()).toBe(1)
  })

  it('moves a tag onto a free key', () => {
    const track = seedTrack()
    const tag = store.addTag([track], 'Wokrout', 'user')!

    const renamed = store.renameTag(tag.id, 'Workout')

    expect(renamed).toEqual({ id: tag.id, key: 'workout', label: 'Workout' })
    expect(store.tagsForTrack(track).user).toEqual([
      { id: tag.id, label: 'Workout', source: 'user' }
    ])
  })

  it('merges into an existing tag when the new key collides', () => {
    const a = seedTrack()
    const b = seedTrack()
    const keep = store.addTag([a], 'Electronic', 'user')!
    const merge = store.addTag([b], 'Electronica', 'user')!

    const survivor = store.renameTag(merge.id, 'Electronic')

    expect(survivor).toEqual(keep)
    expect(tagRowCount()).toBe(1)
    // b's assignment now points at the surviving tag.
    expect(store.tagsForTrack(b).user).toEqual([
      { id: keep.id, label: 'Electronic', source: 'user' }
    ])
  })

  it('dedupes when a merge target track already carries both tags', () => {
    const track = seedTrack()
    const keep = store.addTag([track], 'Electronic', 'user')!
    const merge = store.addTag([track], 'Electronica', 'user')!

    store.renameTag(merge.id, 'Electronic')

    expect(tagRowCount()).toBe(1)
    expect(store.tagsForTrack(track).user).toEqual([
      { id: keep.id, label: 'Electronic', source: 'user' }
    ])
  })

  it('returns null for a tag id that does not exist', () => {
    expect(store.renameTag(9999, 'Whatever')).toBeNull()
  })
})

describe('rescan-safety (D7)', () => {
  /**
   * The card's load-bearing test: a rescan rebuilds `track_genres` from the file
   * but must never touch `track_tags`. Upsert a tagged track twice, with a new
   * file genre the second time, and assert the file genres re-derive while the
   * user tag stays exactly where it was.
   */
  it('leaves user tags untouched across a re-upsert that changes file genres', () => {
    const track = seedTrack('Rock')
    const tag = store.addTag([track], 'Roadtrip', 'user')!

    rescan(0, 'Ambient')

    expect(store.tagsForTrack(track)).toEqual({
      file: ['Ambient'],
      user: [{ id: tag.id, label: 'Roadtrip', source: 'user' }]
    })
    expect(joinRowCount()).toBe(1)
  })
})

describe('cascade', () => {
  it('severs assignments when the track is deleted but leaves the vocabulary', () => {
    const track = seedTrack()
    const tag = store.addTag([track], 'Keeper', 'user')!

    library.deleteTracks(rootId, ['t0.flac'])

    expect(joinRowCount()).toBe(0)
    // The vocabulary survives a track vanishing — see the store header.
    expect(store.listTags()).toEqual([expect.objectContaining({ id: tag.id, trackCount: 0 })])
  })
})
