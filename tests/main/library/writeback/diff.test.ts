import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GenreValue } from '@shared/tagWriteback'
import { openDatabase, type OpenDatabaseResult } from '../../../../src/main/db'
import { LibraryStore } from '../../../../src/main/library/store'
import type { MetadataReader, TrackTags } from '../../../../src/main/library/metadata'
import { TagStore } from '../../../../src/main/tags/store'
import {
  computePendingWrite,
  NO_OVERRIDE,
  type GenreCanonicalizer,
  type TrackOverrideRow,
  type WritebackUserTag
} from '../../../../src/main/library/writeback/diff'
import { TagWritebackDiffer } from '../../../../src/main/library/writeback/differ'

/**
 * The pending-write diff model — W16-1, design authority D28.
 *
 * The pure-merge suite drives {@link computePendingWrite} against synthesised
 * inputs: it owns every claim about precedence, the genre union and the
 * `hasChanges` roll-up. The differ suite drives {@link TagWritebackDiffer}
 * against a real migrated database, and exists for the one property the pure
 * function cannot have — that `current` is a *fresh read of the file*, so an
 * out-of-band edit (R7) is diffed against the bytes and not the cached row.
 */

/** A file's tags, defaulting to a plain fully-populated track. */
function fileTags(over: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'File Title',
    artist: 'File Artist',
    album: 'File Album',
    albumArtist: 'File Artist',
    trackNo: 3,
    discNo: 1,
    year: 2001,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: 'Rock',
    replayGain: null,
    ...over
  }
}

/** An override row, defaulting to no override at all. */
function override(over: Partial<TrackOverrideRow> = {}): TrackOverrideRow {
  return { ...NO_OVERRIDE, ...over }
}

function userTag(label: string, source: WritebackUserTag['source'] = 'user'): WritebackUserTag {
  return { label, source }
}

function keys(values: readonly GenreValue[]): string[] {
  return values.map((v) => v.key)
}

function labels(values: readonly GenreValue[]): string[] {
  return values.map((v) => v.label)
}

describe('computePendingWrite — scalar fields', () => {
  it('proposes the file value and reports no change when there is no override', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override(),
      userTags: []
    })

    expect(pw.title).toEqual({ current: 'File Title', proposed: 'File Title', changed: false })
    expect(pw.year).toEqual({ current: 2001, proposed: 2001, changed: false })
    expect(pw.hasChanges).toBe(false)
  })

  it('lets an override replace the file value and marks the field changed', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override({ title: 'Corrected', track_no: 7, year: 1999 }),
      userTags: []
    })

    expect(pw.title).toEqual({ current: 'File Title', proposed: 'Corrected', changed: true })
    expect(pw.trackNo).toEqual({ current: 3, proposed: 7, changed: true })
    expect(pw.year).toEqual({ current: 2001, proposed: 1999, changed: true })
    // artist_name maps to the artist field; album_title to album.
    expect(pw.artist.changed).toBe(false)
    expect(pw.hasChanges).toBe(true)
  })

  it('maps the override column names onto their fields', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override({ artist_name: 'New Artist', album_title: 'New Album', disc_no: 2 }),
      userTags: []
    })

    expect(pw.artist.proposed).toBe('New Artist')
    expect(pw.album.proposed).toBe('New Album')
    expect(pw.discNo.proposed).toBe(2)
  })

  it('carries a null file value through when nothing overrides it', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ discNo: null }),
      override: override(),
      userTags: []
    })

    expect(pw.discNo).toEqual({ current: null, proposed: null, changed: false })
  })

  it('proposes a value for a field the file omits when an override supplies one', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ discNo: null }),
      override: override({ disc_no: 1 }),
      userTags: []
    })

    expect(pw.discNo).toEqual({ current: null, proposed: 1, changed: true })
  })
})

describe('computePendingWrite — genre merge', () => {
  it('proposes the file genre frame unchanged when no layer touches it', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: 'Rock; Pop' }),
      override: override(),
      userTags: []
    })

    expect(labels(pw.genres.current)).toEqual(['Rock', 'Pop'])
    expect(labels(pw.genres.proposed)).toEqual(['Rock', 'Pop'])
    expect(pw.genres.changed).toBe(false)
  })

  it('unions user and suggested tags onto the file genre frame', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: 'Rock' }),
      override: override(),
      userTags: [userTag('Shoegaze'), userTag('Dream Pop', 'suggested')]
    })

    expect(labels(pw.genres.proposed)).toEqual(['Rock', 'Shoegaze', 'Dream Pop'])
    expect(pw.genres.changed).toBe(true)
    expect(pw.hasChanges).toBe(true)
  })

  it('drops a tag whose key the base already carries, keeping the base spelling', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: 'Rock' }),
      override: override(),
      userTags: [userTag('ROCK'), userTag('Indie')]
    })

    // 'ROCK' folds onto the existing 'rock' key; the file's 'Rock' spelling wins.
    expect(labels(pw.genres.proposed)).toEqual(['Rock', 'Indie'])
    expect(keys(pw.genres.proposed)).toEqual(['rock', 'indie'])
  })

  it('lets a genre override replace the file frame as the base for the union', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: 'Rock; Pop' }),
      override: override({ genre: 'Jazz' }),
      userTags: [userTag('Bebop')]
    })

    // Override replaces the file's Rock/Pop base; tags union on.
    expect(labels(pw.genres.current)).toEqual(['Rock', 'Pop'])
    expect(labels(pw.genres.proposed)).toEqual(['Jazz', 'Bebop'])
    expect(pw.genres.changed).toBe(true)
  })

  it('splits a multi-valued genre override with the shared splitter', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: null }),
      override: override({ genre: 'Folk/Rock, Americana' }),
      userTags: []
    })

    expect(labels(pw.genres.proposed)).toEqual(['Folk', 'Rock', 'Americana'])
  })

  it('detects a spelling-only change to a genre as a change', () => {
    const canonicalize: GenreCanonicalizer = (genres) =>
      genres.map((g) => (g.key === 'rock' ? { key: 'rock', label: 'ROCK' } : g))

    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: 'Rock' }),
      override: override(),
      userTags: [],
      canonicalize
    })

    expect(labels(pw.genres.current)).toEqual(['Rock'])
    expect(labels(pw.genres.proposed)).toEqual(['ROCK'])
    expect(pw.genres.changed).toBe(true)
  })

  it('runs the canonicalizer over the merged set (W16-5 seam)', () => {
    // A canonicalizer that folds 'hip hop' and 'rap' onto one canonical genre.
    const canonicalize: GenreCanonicalizer = (genres) => {
      const out: GenreValue[] = []
      const seen = new Set<string>()
      for (const g of genres) {
        const key = g.key === 'rap' ? 'hip hop' : g.key
        const label = key === 'hip hop' ? 'Hip-Hop' : g.label
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ key, label })
        }
      }
      return out
    }

    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: 'Hip Hop' }),
      override: override(),
      userTags: [userTag('Rap')],
      canonicalize
    })

    expect(labels(pw.genres.proposed)).toEqual(['Hip-Hop'])
    expect(keys(pw.genres.proposed)).toEqual(['hip hop'])
  })

  it('treats an empty-after-canonicalization set against an empty file frame as no change', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags({ genre: null }),
      override: override(),
      userTags: []
    })

    expect(pw.genres.current).toEqual([])
    expect(pw.genres.proposed).toEqual([])
    expect(pw.genres.changed).toBe(false)
    expect(pw.hasChanges).toBe(false)
  })
})

describe('computePendingWrite — artwork', () => {
  const FILE = { present: true, hash: 'file'.padEnd(64, '0'), mime: 'image/jpeg' } as const
  const CHOSEN = { imageHash: 'new'.padEnd(64, '0'), mime: 'image/png' }

  it('proposes the file cover and reports no change when there is no override', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override(),
      userTags: [],
      fileArtwork: FILE
    })
    expect(pw.artwork).toEqual({ current: FILE, proposed: FILE, changed: false })
    expect(pw.hasChanges).toBe(false)
  })

  it('proposes a set override as the new cover', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override(),
      userTags: [],
      fileArtwork: FILE,
      artworkOverride: CHOSEN
    })
    expect(pw.artwork.current).toEqual(FILE)
    expect(pw.artwork.proposed).toEqual({
      present: true,
      hash: CHOSEN.imageHash,
      mime: CHOSEN.mime
    })
    expect(pw.artwork.changed).toBe(true)
    expect(pw.hasChanges).toBe(true)
  })

  it('proposes a clear override as absent', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override(),
      userTags: [],
      fileArtwork: FILE,
      artworkOverride: { imageHash: null, mime: null }
    })
    expect(pw.artwork.proposed).toEqual({ present: false, hash: null, mime: null })
    expect(pw.artwork.changed).toBe(true)
  })

  it('does not count a same-hash override as a change', () => {
    const pw = computePendingWrite({
      trackId: 1,
      file: fileTags(),
      override: override(),
      userTags: [],
      fileArtwork: FILE,
      artworkOverride: { imageHash: FILE.hash, mime: 'image/png' }
    })
    expect(pw.artwork.changed).toBe(false)
    expect(pw.hasChanges).toBe(false)
  })
})

describe('TagWritebackDiffer — fresh file read (R7)', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let db: Database.Database
  let library: LibraryStore
  let tags: TagStore
  let rootId: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-writeback-'))
    opened = openDatabase(join(dir, 'library.db'))
    db = opened.db
    rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Music', '/music', 1).lastInsertRowid
    )
    library = new LibraryStore(db)
    tags = new TagStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function seedTrack(scanned: TrackTags): number {
    library.writeTracks(rootId, [
      {
        file: { absPath: '/music/song.flac', relPath: 'song.flac', size: 1000, mtime: 1 },
        tags: scanned
      }
    ])
    return Number(
      (db.prepare('SELECT id FROM tracks WHERE rel_path = ?').get('song.flac') as { id: number }).id
    )
  }

  it('diffs against the file on disk, not the cached tracks row', async () => {
    // Scanned (cached) row says the title is 'Old'; the file now says 'New' —
    // an out-of-band retag since the last scan.
    const trackId = seedTrack(fileTags({ title: 'Old' }))
    const liveReader: MetadataReader = async () => fileTags({ title: 'New' })

    const differ = new TagWritebackDiffer(db, liveReader)
    const pw = await differ.pendingWrite(trackId)

    // current is the file's live value, not the row's 'Old'.
    expect(pw?.title.current).toBe('New')
  })

  it('reads genre and year from the extended override row (migration 019)', async () => {
    const trackId = seedTrack(fileTags({ genre: 'Rock', year: 2001 }))
    db.prepare(
      'INSERT INTO track_overrides (track_id, genre, year, updated_at) VALUES (?, ?, ?, ?)'
    ).run(trackId, 'Jazz', 1995, 1)

    const differ = new TagWritebackDiffer(db, async () => fileTags({ genre: 'Rock', year: 2001 }))
    const pw = await differ.pendingWrite(trackId)

    expect(pw?.year).toEqual({ current: 2001, proposed: 1995, changed: true })
    expect(labels(pw!.genres.proposed)).toEqual(['Jazz'])
    expect(pw?.genres.changed).toBe(true)
  })

  it('unions the track_tags user layer into the genre diff', async () => {
    const trackId = seedTrack(fileTags({ genre: 'Rock' }))
    tags.addTag([trackId], 'Shoegaze', 'user')

    const differ = new TagWritebackDiffer(db, async () => fileTags({ genre: 'Rock' }))
    const pw = await differ.pendingWrite(trackId)

    expect(labels(pw!.genres.proposed)).toEqual(['Rock', 'Shoegaze'])
  })

  it('returns null for a track that does not exist', async () => {
    const differ = new TagWritebackDiffer(db, async () => fileTags())
    expect(await differ.pendingWrite(99999)).toBeNull()
  })

  it('diffs artwork against the album cover and the override row', async () => {
    const fileHash = 'f'.repeat(64)
    const chosenHash = 'c'.repeat(64)
    const trackId = seedTrack(fileTags())
    const albumId = (
      db.prepare('SELECT album_id AS id FROM tracks WHERE id = ?').get(trackId) as { id: number }
    ).id
    library.setAlbumArtwork(albumId, fileHash)
    library.setArtworkOverride(trackId, chosenHash, 'image/png', 1)

    const differ = new TagWritebackDiffer(db, async () => fileTags())
    const pw = await differ.pendingWrite(trackId)

    expect(pw?.artwork.current).toEqual({ present: true, hash: fileHash, mime: null })
    expect(pw?.artwork.proposed).toEqual({ present: true, hash: chosenHash, mime: 'image/png' })
    expect(pw?.artwork.changed).toBe(true)
    expect(pw?.hasChanges).toBe(true)
  })
})
