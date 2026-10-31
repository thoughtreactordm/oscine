import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { AgentReadStore } from '../../../src/main/library/agentReads'
import type { TrackTags } from '../../../src/main/library/metadata'
import { LibraryStore } from '../../../src/main/library/store'

/**
 * Migration 028's scan facts (W24-4): every parse records whether the file named
 * an album artist and the file's own year — the two things the album grouping
 * hides — and a re-read replaces them. These are what `find_issues` judges.
 */

let dir: string
let opened: OpenDatabaseResult

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-scan-facts-'))
  opened = openDatabase(join(dir, 'library.db'))
})

afterEach(() => {
  opened.db.close()
  rmSync(dir, { recursive: true, force: true })
})

function tags(overrides: Partial<TrackTags>): TrackTags {
  return {
    title: 'A Track',
    artist: 'Performer',
    album: 'An Album',
    albumArtist: null,
    trackNo: 1,
    discNo: null,
    year: null,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: null,
    replayGain: null,
    lyrics: null,
    ...overrides
  }
}

describe('scan facts', () => {
  it('records the album-artist tag and per-track year, and a re-read replaces them', () => {
    const { db } = opened
    const rootId = Number(
      db.prepare("INSERT INTO roots (label, path, added_at) VALUES ('Music', '/m', 1)").run()
        .lastInsertRowid
    )
    const store = new LibraryStore(db)
    const scanned = (relPath: string, overrides: Partial<TrackTags>) => ({
      file: { absPath: `/m/${relPath}`, relPath, size: 1, mtime: 1 },
      tags: tags(overrides)
    })
    store.writeTracks(rootId, [
      scanned('a.flac', { year: 1999 }),
      scanned('b.flac', { year: 2003, title: 'B' })
    ])
    const facts = () =>
      db.prepare('SELECT rel_path, tag_album_artist, tag_year FROM tracks ORDER BY rel_path').all()
    expect(facts()).toEqual([
      { rel_path: 'a.flac', tag_album_artist: 0, tag_year: 1999 },
      { rel_path: 'b.flac', tag_album_artist: 0, tag_year: 2003 }
    ])

    // Grouped under the performer, yet reported missing; the years disagree.
    const reads = new AgentReadStore(db)
    expect(reads.issues('missingAlbumArtist')).toHaveLength(1)
    expect(reads.issues('yearMismatch')[0]?.years).toEqual([
      { year: 1999, tracks: 1 },
      { year: 2003, tracks: 1 }
    ])

    store.writeTracks(rootId, [
      scanned('a.flac', { year: 2003, albumArtist: 'Performer' }),
      scanned('b.flac', { year: 2003, title: 'B', albumArtist: 'Performer' })
    ])
    expect(facts()).toEqual([
      { rel_path: 'a.flac', tag_album_artist: 1, tag_year: 2003 },
      { rel_path: 'b.flac', tag_album_artist: 1, tag_year: 2003 }
    ])
    expect(reads.issues('missingAlbumArtist')).toEqual([])
    expect(reads.issues('yearMismatch')).toEqual([])
  })
})
