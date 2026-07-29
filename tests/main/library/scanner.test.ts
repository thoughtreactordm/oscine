import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScanProgress } from '../../../src/shared/library'
import { openDatabase } from '../../../src/main/db'
import type { MetadataReader, TrackTags } from '../../../src/main/library/metadata'
import { scanRoot } from '../../../src/main/library/scanner'
import { LibraryStore } from '../../../src/main/library/store'

/**
 * The scan, verified against the database it wrote.
 *
 * Tags are injected rather than read from real files: the parser has its own
 * tests against a real WAV, and driving album identity and failure handling
 * from actual audio would mean a binary fixture per case. What is real here is
 * the filesystem walk and every row that comes out the far side.
 */

let workDir: string
let musicDir: string
let db: ReturnType<typeof openDatabase>['db']
let store: LibraryStore
let rootId: number

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fermata-scan-'))
  musicDir = join(workDir, 'Music')
  mkdirSync(musicDir)

  db = openDatabase(join(workDir, 'library.db')).db
  store = new LibraryStore(db)
  rootId = store.insertRoot(musicDir, 'Music', Date.now()).id
})

afterEach(() => {
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

function touch(relPath: string): void {
  const abs = join(musicDir, ...relPath.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, 'x')
}

/** A fully-null tag set, so each test states only the fields it cares about. */
function tags(overrides: Partial<TrackTags> = {}): TrackTags {
  return {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    // Present by default: the scanner skips anything describing no audio.
    durationMs: 200_000,
    codec: 'flac',
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    replayGain: null,
    ...overrides
  }
}

/** Serves tags by rel_path; anything unlisted parses as a bare audio file. */
function readerFor(byRelPath: Record<string, TrackTags>): MetadataReader {
  return async (absPath) => {
    const rel = absPath.slice(musicDir.length + 1).split(/[\\/]/).join('/')
    return byRelPath[rel] ?? tags()
  }
}

function scan(
  reader: MetadataReader,
  onProgress?: (p: ScanProgress) => void,
  now?: () => number
) {
  return scanRoot(store, { id: rootId, path: musicDir }, { readMetadata: reader, onProgress, now })
}

/**
 * A clock that jumps past the progress throttle on every reading.
 *
 * A scan of stub files finishes well inside the 120ms interval, so with the
 * real clock the throttle correctly suppresses every interim event and there is
 * nothing to assert about. Driving time makes the emission deterministic.
 */
function impatientClock(): () => number {
  let at = 1_700_000_000_000
  return () => (at += 1_000)
}

/** Direct database inspection, which is what the card's acceptance asks for. */
function trackRows(): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT t.rel_path AS relPath, t.title AS title, t.track_no AS trackNo,
              t.disc_no AS discNo, t.duration_ms AS durationMs, t.codec AS codec,
              t.sample_rate AS sampleRate, t.channels AS channels, t.bit_depth AS bitDepth,
              t.mtime AS mtime, t.size AS size,
              t.rg_track_gain AS rgTrackGain, t.rg_track_peak AS rgTrackPeak,
              t.rg_album_gain AS rgAlbumGain, t.rg_album_peak AS rgAlbumPeak,
              t.rg_source AS rgSource,
              ar.name AS artist, al.title AS album, al.year AS albumYear,
              aa.name AS albumArtist
       FROM tracks t
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums  al ON al.id = t.album_id
       LEFT JOIN artists aa ON aa.id = al.album_artist_id
       ORDER BY t.rel_path`
    )
    .all() as Array<Record<string, unknown>>
}

function count(table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
}

describe('scanRoot', () => {
  it('turns a folder of files into track rows', async () => {
    touch('Boards of Canada/Geogaddi/03.flac')
    touch('Boards of Canada/Geogaddi/04.flac')

    const summary = await scan(
      readerFor({
        'Boards of Canada/Geogaddi/03.flac': tags({
          title: 'Julie and Candy',
          artist: 'Boards of Canada',
          album: 'Geogaddi',
          trackNo: 9,
          year: 2002
        })
      })
    )

    expect(summary.filesSeen).toBe(2)
    expect(summary.tracksIndexed).toBe(2)
    expect(summary.filesSkipped).toBe(0)

    const rows = trackRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      relPath: 'Boards of Canada/Geogaddi/03.flac',
      title: 'Julie and Candy',
      artist: 'Boards of Canada',
      album: 'Geogaddi',
      albumYear: 2002,
      trackNo: 9,
      codec: 'flac',
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      durationMs: 200_000
    })
  })

  it('stores rel_path in POSIX form and records mtime and size', async () => {
    touch('Artist/Album/01.flac')

    await scan(readerFor({}))

    const [row] = trackRows()
    expect(row.relPath).toBe('Artist/Album/01.flac')
    expect(row.size).toBe(1)
    expect(row.mtime).toBeGreaterThan(0)
  })

  it('reports timestamps and the root it scanned', async () => {
    touch('a.flac')
    const summary = await scan(readerFor({}))

    expect(summary.rootId).toBe(rootId)
    expect(Date.parse(summary.startedAt)).not.toBeNaN()
    expect(Date.parse(summary.finishedAt)).toBeGreaterThanOrEqual(Date.parse(summary.startedAt))
    // `roots.last_scan_at` is what M3's incremental rescan will key off.
    expect(store.getRoot(rootId)?.lastScanAt).toBeGreaterThan(0)
  })

  it('falls back to the filename when a file carries no title tag', async () => {
    touch('Artist/03 - Untitled.flac')

    await scan(readerFor({}))

    expect(trackRows()[0].title).toBe('03 - Untitled')
  })

  it('indexes only supported files, skipping the rest of the folder', async () => {
    touch('Artist/track.flac')
    touch('Artist/cover.jpg')
    touch('Artist/album.cue')
    touch('.hidden/track.flac')

    const summary = await scan(readerFor({}))

    expect(summary.filesSeen).toBe(1)
    expect(trackRows().map((row) => row.relPath)).toEqual(['Artist/track.flac'])
  })
})

/**
 * Album identity, which the card calls out specifically because getting it
 * wrong shatters compilations into one album per track.
 */
describe('scanRoot and album identity', () => {
  it('collapses one album into a single row across its tracks', async () => {
    touch('a.flac')
    touch('b.flac')

    await scan(
      readerFor({
        'a.flac': tags({ artist: 'Boards of Canada', album: 'Geogaddi' }),
        'b.flac': tags({ artist: 'Boards of Canada', album: 'Geogaddi' })
      })
    )

    expect(count('albums')).toBe(1)
    expect(count('artists')).toBe(1)
  })

  it('keeps a compilation together when the album artist agrees', async () => {
    touch('a.flac')
    touch('b.flac')

    await scan(
      readerFor({
        'a.flac': tags({ artist: 'Aphex Twin', albumArtist: 'Various Artists', album: 'Warp10' }),
        'b.flac': tags({ artist: 'Autechre', albumArtist: 'Various Artists', album: 'Warp10' })
      })
    )

    expect(count('albums')).toBe(1)
    const rows = trackRows()
    expect(rows.map((row) => row.artist)).toEqual(['Aphex Twin', 'Autechre'])
    // Every track points at the one album, whose artist is the compilation's.
    expect(rows.map((row) => row.albumArtist)).toEqual(['Various Artists', 'Various Artists'])
  })

  it('falls back to the track artist when no album artist is tagged', async () => {
    touch('a.flac')
    touch('b.flac')

    await scan(
      readerFor({
        'a.flac': tags({ artist: 'Sigur Rós', album: '( )' }),
        'b.flac': tags({ artist: 'Sigur Rós', album: '( )' })
      })
    )

    expect(count('albums')).toBe(1)
    expect(trackRows()[0].albumArtist).toBe('Sigur Rós')
  })

  it('separates same-titled albums by different artists', async () => {
    touch('a.flac')
    touch('b.flac')

    await scan(
      readerFor({
        'a.flac': tags({ artist: 'Queen', album: 'Greatest Hits' }),
        'b.flac': tags({ artist: 'ABBA', album: 'Greatest Hits' })
      })
    )

    expect(count('albums')).toBe(2)
  })

  it('still collapses an album when no artist is known at all', async () => {
    // The NULL trap: UNIQUE(title, album_artist_id) does not constrain rows
    // whose album artist is NULL, because SQLite treats every NULL as distinct.
    // A lookup by equality would miss the existing row and create one album per
    // track — so this is the case that proves the `IS` comparison.
    touch('a.flac')
    touch('b.flac')
    touch('c.flac')

    await scan(readerFor({ 'a.flac': tags({ album: 'Untitled' }) }))
    // Only 'a' has an album; re-scan with all three sharing it.
    await scan(
      readerFor({
        'a.flac': tags({ album: 'Untitled' }),
        'b.flac': tags({ album: 'Untitled' }),
        'c.flac': tags({ album: 'Untitled' })
      })
    )

    expect(count('albums')).toBe(1)
    expect(count('artists')).toBe(0)
  })

  it('fills in an album year that the first track was missing', async () => {
    touch('a.flac')
    touch('b.flac')

    await scan(
      readerFor({
        'a.flac': tags({ artist: 'Boards of Canada', album: 'Geogaddi' }),
        'b.flac': tags({ artist: 'Boards of Canada', album: 'Geogaddi', year: 2002 })
      })
    )

    expect(trackRows()[0].albumYear).toBe(2002)
  })
})

describe('scanRoot and ReplayGain', () => {
  it('stores tagged gain with rg_source = tag', async () => {
    touch('a.flac')

    await scan(
      readerFor({
        'a.flac': tags({
          replayGain: {
            trackGainDb: -7.5,
            trackPeak: 0.944,
            albumGainDb: -6.25,
            albumPeak: 0.988
          }
        })
      })
    )

    expect(trackRows()[0]).toMatchObject({
      rgTrackGain: -7.5,
      rgTrackPeak: 0.944,
      rgAlbumGain: -6.25,
      rgAlbumPeak: 0.988,
      rgSource: 'tag'
    })
  })

  it('leaves rg_source NULL when the file carries no gain, so M2 knows to compute', async () => {
    touch('a.flac')

    await scan(readerFor({}))

    expect(trackRows()[0]).toMatchObject({ rgTrackGain: null, rgSource: null })
  })
})

describe('scanRoot and the FTS index', () => {
  it('makes an indexed track searchable', async () => {
    touch('a.flac')

    await scan(
      readerFor({
        'a.flac': tags({
          title: 'Julie and Candy',
          artist: 'Boards of Canada',
          album: 'Geogaddi'
        })
      })
    )

    const hits = db
      .prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'geogaddi'")
      .all() as Array<{ rowid: number }>
    const trackId = (db.prepare('SELECT id FROM tracks').get() as { id: number }).id

    expect(hits.map((hit) => hit.rowid)).toEqual([trackId])
  })

  it('does not accumulate duplicate index entries across re-scans', async () => {
    // Contentless FTS5 cannot delete by rowid, so a re-scan that forgot to
    // remove the old entry would leave the track matching twice — and the only
    // symptom is a duplicated search result much later.
    touch('a.flac')
    const reader = readerFor({ 'a.flac': tags({ title: 'Julie and Candy' }) })

    await scan(reader)
    await scan(reader)

    const hits = db
      .prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'julie'")
      .all()
    expect(hits).toHaveLength(1)
  })

  it('follows a retagged track rather than leaving the old words behind', async () => {
    touch('a.flac')

    await scan(readerFor({ 'a.flac': tags({ title: 'Working Title' }) }))
    await scan(readerFor({ 'a.flac': tags({ title: 'Julie and Candy' }) }))

    const stale = db.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'working'").all()
    const fresh = db.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'julie'").all()

    expect(stale).toHaveLength(0)
    expect(fresh).toHaveLength(1)
  })
})

describe('scanRoot resilience', () => {
  it('skips a file whose parse throws and indexes the rest', async () => {
    touch('good1.flac')
    touch('bad.flac')
    touch('good2.flac')

    const summary = await scan(async (absPath) => {
      if (absPath.endsWith('bad.flac')) throw new Error('corrupt header')
      return tags()
    })

    expect(summary.filesSeen).toBe(3)
    expect(summary.tracksIndexed).toBe(2)
    expect(summary.filesSkipped).toBe(1)
    expect(trackRows().map((row) => row.relPath)).toEqual(['good1.flac', 'good2.flac'])
  })

  it('skips a file that parses without describing any audio', async () => {
    // The renamed-text-file case. `music-metadata` resolves rather than
    // throwing, so emptiness is the only signal available.
    touch('real.flac')
    touch('notmusic.wav')

    const summary = await scan(async (absPath) =>
      absPath.endsWith('notmusic.wav') ? tags({ durationMs: null, codec: null }) : tags()
    )

    expect(summary.tracksIndexed).toBe(1)
    expect(summary.filesSkipped).toBe(1)
    expect(trackRows().map((row) => row.relPath)).toEqual(['real.flac'])
  })

  it('survives a batch entirely made of failures', async () => {
    touch('a.flac')
    touch('b.flac')

    const summary = await scan(async () => {
      throw new Error('nope')
    })

    expect(summary.tracksIndexed).toBe(0)
    expect(summary.filesSkipped).toBe(2)
    expect(count('tracks')).toBe(0)
  })

  it('re-scanning updates in place instead of duplicating rows', async () => {
    touch('a.flac')

    await scan(readerFor({ 'a.flac': tags({ title: 'Working Title' }) }))
    const firstId = (db.prepare('SELECT id FROM tracks').get() as { id: number }).id

    await scan(readerFor({ 'a.flac': tags({ title: 'Julie and Candy' }) }))

    expect(count('tracks')).toBe(1)
    const rows = trackRows()
    expect(rows[0].title).toBe('Julie and Candy')
    // The id is stable, which is what keeps playlist entries pointing at it.
    expect((db.prepare('SELECT id FROM tracks').get() as { id: number }).id).toBe(firstId)
  })

  it('preserves play counts and ratings across a re-scan', async () => {
    // These are user data, not file data. A re-scan must not touch them.
    touch('a.flac')
    await scan(readerFor({}))
    db.prepare('UPDATE tracks SET play_count = 12, rating = 5').run()

    await scan(readerFor({}))

    expect(db.prepare('SELECT play_count AS p, rating AS r FROM tracks').get()).toEqual({
      p: 12,
      r: 5
    })
  })

  it('handles more files than fit in one write batch', async () => {
    // BATCH_SIZE is 128; this crosses it, so the batching and the yield between
    // batches are actually exercised.
    for (let i = 0; i < 300; i++) touch(`Artist/${String(i).padStart(3, '0')}.flac`)

    const summary = await scan(readerFor({}))

    expect(summary.filesSeen).toBe(300)
    expect(summary.tracksIndexed).toBe(300)
    expect(count('tracks')).toBe(300)
  })
})

describe('scanRoot progress reporting', () => {
  it('reports an immediate first event and a final one marked done', async () => {
    touch('a.flac')

    const events: ScanProgress[] = []
    const summary = await scan(readerFor({}), (progress) => events.push(progress))

    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]).toMatchObject({ rootId, filesSeen: 0, tracksIndexed: 0, done: false })

    const last = events[events.length - 1]
    expect(last).toMatchObject({ done: true, currentFile: null })
    // The final counts agree with the summary, so the UI's last frame is right.
    expect(last.filesSeen).toBe(summary.filesSeen)
    expect(last.tracksIndexed).toBe(summary.tracksIndexed)
  })

  it('keeps quiet during a scan too fast to need progress', async () => {
    // The throttle earning its place: with the real clock this whole scan
    // finishes inside one interval, so the renderer is woken twice rather than
    // two hundred times.
    for (let i = 0; i < 200; i++) touch(`Artist/${String(i).padStart(3, '0')}.flac`)

    const events: ScanProgress[] = []
    await scan(readerFor({}), (progress) => events.push(progress))

    expect(events.length).toBeLessThan(10)
    expect(events[events.length - 1].done).toBe(true)
  })

  it('names only the basename, never a path', async () => {
    for (let i = 0; i < 200; i++) touch(`Artist/Album/${String(i).padStart(3, '0')}.flac`)

    const events: ScanProgress[] = []
    await scan(readerFor({}), (progress) => events.push(progress), impatientClock())

    const named = events.filter((event) => event.currentFile !== null)
    expect(named.length).toBeGreaterThan(0)
    for (const event of named) {
      // A full path here would leak the filesystem layout into the renderer.
      expect(event.currentFile).not.toContain('/')
      expect(event.currentFile).not.toContain('\\')
      expect(event.currentFile).toMatch(/^\d{3}\.flac$/)
    }
  })

  it('still reports done when the scan fails outright', async () => {
    touch('a.flac')
    // A database failure is not a per-file skip: it propagates. The UI must
    // still be told the scan ended, or its indicator runs forever.
    db.prepare('DROP TABLE tracks_fts').run()

    const events: ScanProgress[] = []
    await expect(scan(readerFor({}), (progress) => events.push(progress))).rejects.toThrow()

    expect(events[events.length - 1]).toMatchObject({ done: true })
  })
})
