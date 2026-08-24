import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import { SearchStore } from '../../../src/main/search/store'
import type { SearchEntityKind, SearchMode } from '@shared/search'
import type { TrackTags } from '../../../src/main/library/metadata'

/**
 * D23's finder, from the store side: one grouped, ranked pass. Tracks come off
 * `tracks_fts` (trigram, three-character floor); albums, artists, playlists and
 * shows off a light LIKE. Groups arrive in the D21 category order — album,
 * artist, playlist, track, show — with empties omitted, and the `artist` /
 * `playlist` prefix modes answer with only their own group.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-search-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tags(overrides: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'A Track',
    artist: 'An Artist',
    album: 'An Album',
    albumArtist: 'An Artist',
    trackNo: 1,
    discNo: null,
    year: 2001,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: null,
    replayGain: null,
    ...overrides
  }
}

function scanned(relPath: string, overrides: Partial<TrackTags> = {}) {
  return {
    file: { absPath: `/music/${relPath}`, relPath, size: 1000, mtime: 1 },
    tags: tags(overrides)
  }
}

function addRoot(db: Database.Database): number {
  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 1).lastInsertRowid
  )
}

function addPlaylist(db: Database.Database, name: string, entryTrackIds: number[] = []): number {
  const id = Number(
    db
      .prepare('INSERT INTO playlists (name, position, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(name, 0, 1, 1).lastInsertRowid
  )
  let position = 1
  for (const trackId of entryTrackIds) {
    db.prepare(
      'INSERT INTO playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)'
    ).run(id, trackId, position++)
  }
  return id
}

function addPodcast(db: Database.Database, title: string, author: string | null): void {
  db.prepare(
    `INSERT INTO podcasts (feed_url, title, author, subscribed_at)
     VALUES (?, ?, ?, ?)`
  ).run(`https://example.com/${encodeURIComponent(title)}.xml`, title, author, 1)
}

const kinds = (groups: { kind: SearchEntityKind }[]): SearchEntityKind[] =>
  groups.map((group) => group.kind)

const q = (text: string, mode: SearchMode = 'blended', limitPerGroup = 10) => ({
  text,
  mode,
  limitPerGroup
})

describe('SearchStore.query', () => {
  let opened: OpenDatabaseResult
  let library: LibraryStore
  let search: SearchStore
  let rootId: number

  beforeEach(() => {
    opened = openDatabase(join(dir, 'library.db'))
    rootId = addRoot(opened.db)
    library = new LibraryStore(opened.db)
    search = new SearchStore(opened.db)

    library.writeTracks(rootId, [
      scanned('boc-1.flac', {
        title: 'Roygbiv',
        artist: 'Boards of Canada',
        album: 'Music Has the Right to Children',
        albumArtist: 'Boards of Canada'
      }),
      scanned('boc-2.flac', {
        title: 'Aquarius',
        artist: 'Boards of Canada',
        album: 'Music Has the Right to Children',
        albumArtist: 'Boards of Canada'
      }),
      scanned('at-1.flac', {
        title: 'Windowlicker',
        artist: 'Aphex Twin',
        album: 'Windowlicker',
        albumArtist: 'Aphex Twin'
      })
    ])
  })

  afterEach(() => {
    opened.db.close()
  })

  const trackId = (title: string): number =>
    (opened.db.prepare('SELECT id FROM tracks WHERE title = ?').get(title) as { id: number }).id

  it('returns matching groups in the D21 category order, empties omitted', () => {
    const boc = trackId('Roygbiv')
    addPlaylist(opened.db, 'Boards Mix', [boc, trackId('Aquarius')])

    const result = search.query(q('board'))

    // No album or show matches "board"; artist, playlist and track do.
    expect(kinds(result.groups)).toEqual(['artist', 'playlist', 'track'])

    const artist = result.groups.find((g) => g.kind === 'artist')
    expect(artist?.hits.map((h) => h.title)).toEqual(['Boards of Canada'])

    const playlist = result.groups.find((g) => g.kind === 'playlist')
    expect(playlist?.hits[0]).toMatchObject({ title: 'Boards Mix', subtitle: '2 tracks' })

    const track = result.groups.find((g) => g.kind === 'track')
    expect(track?.hits.map((h) => h.title).sort()).toEqual(['Aquarius', 'Roygbiv'])
  })

  it('matches tracks through the album column of the FTS index', () => {
    addPodcast(opened.db, 'Music Talk', 'Some Host')

    const result = search.query(q('music'))

    // Album title and a subscribed show both contain "music"; the two tracks
    // match on their indexed album name.
    expect(kinds(result.groups)).toEqual(['album', 'track', 'show'])
    expect(result.groups.find((g) => g.kind === 'show')?.hits[0]).toMatchObject({
      title: 'Music Talk',
      subtitle: 'Some Host'
    })
  })

  it('omits the track group below the trigram floor but still serves LIKE groups', () => {
    addPlaylist(opened.db, 'Boards Mix')

    const result = search.query(q('bo'))

    expect(kinds(result.groups)).not.toContain('track')
    expect(result.groups.find((g) => g.kind === 'artist')?.hits.map((h) => h.title)).toEqual([
      'Boards of Canada'
    ])
    expect(result.groups.find((g) => g.kind === 'playlist')?.hits.map((h) => h.title)).toEqual([
      'Boards Mix'
    ])
  })

  it('answers the artist prefix mode with only the artist group', () => {
    const result = search.query(q('aphex', 'artist'))
    expect(kinds(result.groups)).toEqual(['artist'])
    expect(result.groups[0].hits.map((h) => h.title)).toEqual(['Aphex Twin'])
  })

  it('answers the playlist prefix mode with only the playlist group', () => {
    addPlaylist(opened.db, 'Chill')
    const result = search.query(q('chill', 'playlist'))
    expect(kinds(result.groups)).toEqual(['playlist'])
    expect(result.groups[0].hits[0]).toMatchObject({ title: 'Chill', subtitle: '0 tracks' })
  })

  it('ranks exact over prefix over substring within a group', () => {
    library.writeTracks(rootId, [
      scanned('rock-1.flac', { artist: 'Rock', album: 'R1', albumArtist: 'Rock' }),
      scanned('rock-2.flac', { artist: 'Rockets', album: 'R2', albumArtist: 'Rockets' }),
      scanned('rock-3.flac', { artist: 'Punk Rock', album: 'R3', albumArtist: 'Punk Rock' })
    ])

    const hits = search.query(q('rock', 'artist')).groups[0].hits
    expect(hits.map((h) => h.title)).toEqual(['Rock', 'Rockets', 'Punk Rock'])
    // Scores are monotone with match quality: exact ≥ prefix ≥ substring.
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
    expect(hits[1].score).toBeGreaterThan(hits[2].score)
  })

  it('honours the per-group cap', () => {
    const result = search.query(q('board', 'blended', 1))
    expect(result.groups.find((g) => g.kind === 'track')?.hits).toHaveLength(1)
  })

  it('treats LIKE metacharacters in the query literally', () => {
    addPlaylist(opened.db, '50% Off')
    addPlaylist(opened.db, '5000 Songs')

    const hits = search.query(q('50%', 'playlist')).groups[0].hits
    // Were the `%` a live wildcard, "5000 Songs" would match too.
    expect(hits.map((h) => h.title)).toEqual(['50% Off'])
  })

  it('returns no groups for an empty query', () => {
    expect(search.query(q('   ')).groups).toEqual([])
  })
})
