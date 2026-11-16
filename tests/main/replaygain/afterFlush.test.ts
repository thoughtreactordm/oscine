import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import { TagOverrideStore } from '../../../src/main/library/overrides/tagOverrides'
import { trackAlbumResolver } from '../../../src/main/library/writeback/service'
import { applyFlushedReplayGain } from '../../../src/main/replaygain/afterFlush'

/**
 * W25-6 — what the library knows once a ReplayGain flush lands
 * (oscine-replaygain OQ5), the album join the review's R21 warning groups by,
 * and the "staged" flag the source label reads.
 */

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let rootId: number

function addAlbum(title: string): number {
  return Number(
    db
      .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, NULL, NULL)')
      .run(title).lastInsertRowid
  )
}

function addTrack(name: string, options: { albumId?: number; computed?: boolean } = {}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (
           root_id, rel_path, mtime, size, title, album_id,
           rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, rg_source
         ) VALUES (?, ?, 1, 7, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rootId,
        name,
        name,
        options.albumId ?? null,
        options.computed ? -6.5 : null,
        options.computed ? 0.9 : null,
        options.computed ? -7.25 : null,
        options.computed ? 0.95 : null,
        options.computed ? 'computed' : null
      ).lastInsertRowid
  )
}

function rg(trackId: number): Record<string, unknown> {
  return db
    .prepare(
      `SELECT rg_track_gain AS trackGain, rg_track_peak AS trackPeak,
              rg_album_gain AS albumGain, rg_album_peak AS albumPeak, rg_source AS source
       FROM tracks WHERE id = ?`
    )
    .get(trackId) as Record<string, unknown>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rg-after-flush-'))
  db = openDatabase(join(dir, 'library.db')).db
  rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', dir, Date.now()).lastInsertRowid
  )
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('applyFlushedReplayGain (OQ5)', () => {
  it('flips to tag and takes the file values when the file carries a track gain', () => {
    const id = addTrack('a.flac', { computed: true })
    const changed = applyFlushedReplayGain(db, id, {
      trackGainDb: -6.5,
      trackPeak: 0.9,
      albumGainDb: -7.25,
      albumPeak: 0.95
    })
    expect(changed).toBe(true)
    expect(rg(id)).toEqual({
      trackGain: -6.5,
      trackPeak: 0.9,
      albumGain: -7.25,
      albumPeak: 0.95,
      source: 'tag'
    })
  })

  it('refreshes only the album scope and keeps the measurement when the file has no track gain', () => {
    const id = addTrack('b.flac', { computed: true })
    applyFlushedReplayGain(db, id, {
      trackGainDb: null,
      trackPeak: null,
      albumGainDb: -7.3,
      albumPeak: 0.96
    })
    expect(rg(id)).toEqual({
      trackGain: -6.5,
      trackPeak: 0.9,
      albumGain: -7.3,
      albumPeak: 0.96,
      source: 'computed'
    })
  })

  it('leaves the row alone when the file carries no ReplayGain', () => {
    const id = addTrack('c.flac', { computed: true })
    expect(applyFlushedReplayGain(db, id, null)).toBe(false)
    expect(rg(id)['source']).toBe('computed')
  })
})

describe('trackAlbumResolver (R21)', () => {
  it('maps tracks to their album and leaves singles out', () => {
    const album = addAlbum('Kid A')
    const a = addTrack('a.flac', { albumId: album })
    const b = addTrack('b.flac', { albumId: album })
    const single = addTrack('single.flac')
    const map = trackAlbumResolver(db)([a, b, single, 9999])
    expect([...map.entries()]).toEqual([
      [a, album],
      [b, album]
    ])
  })
})

describe('Track.rgStaged (source label)', () => {
  it('is set while a ReplayGain row is staged, even with the fields held', () => {
    const id = addTrack('a.flac', { computed: true })
    const other = addTrack('b.flac', { computed: true })
    const store = new LibraryStore(db)
    new TagOverrideStore(db).set([id], { replayGainTrackGain: -6.5 }, Date.now())

    const tracks = store.getTracksByIds({ ids: [id, other] })
    expect(tracks.find((track) => track.id === id)?.rgStaged).toBe(true)
    expect(tracks.find((track) => track.id === other)?.rgStaged).toBe(false)
  })
})
