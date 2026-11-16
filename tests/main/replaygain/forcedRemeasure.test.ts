import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { assertStartReplayGainRequest } from '../../../src/main/ipc/validate'
import type { ReplayGainAnalyzer } from '../../../src/main/replaygain/analyzer'
import { ReplayGainJobService } from '../../../src/main/replaygain/jobService'
import type { ReplayGainAnalysis } from '../../../src/main/replaygain/loudness'

/**
 * W25-7 (RG-7): forced re-measure, scoped jobs and the album-whole expansion.
 */

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let rootId: number
const services: ReplayGainJobService[] = []
let cleared: number[][]

function result(gain = -6, peak = 0.8): ReplayGainAnalysis {
  return { trackGainDb: gain, trackPeak: peak, histogram: [[Math.round((-18 - gain) * 10), 1]] }
}

function service(
  analyze: (path: string, signal: AbortSignal) => Promise<ReplayGainAnalysis> = async () => result()
): ReplayGainJobService {
  const instance = new ReplayGainJobService({
    db,
    onProgress: () => {},
    onStagedCleared: (trackIds) => cleared.push(trackIds),
    createAnalyzer: () => ({ analyze, close: async () => {} }) satisfies ReplayGainAnalyzer
  })
  services.push(instance)
  return instance
}

function addAlbum(title: string): number {
  return Number(
    db
      .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, NULL, NULL)')
      .run(title).lastInsertRowid
  )
}

function addTrack(
  name: string,
  options: { albumId?: number; source?: 'tag' | 'computed'; gain?: number; peak?: number } = {}
): number {
  writeFileSync(join(dir, name), 'fixture')
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, album_id,
                             rg_track_gain, rg_track_peak, rg_source)
         VALUES (?, ?, 1, 7, ?, ?, ?, ?, ?)`
      )
      .run(
        rootId,
        name,
        name,
        options.albumId ?? null,
        options.gain ?? null,
        options.peak ?? null,
        options.source ?? null
      ).lastInsertRowid
  )
}

function rg(trackId: number): unknown {
  return db
    .prepare(
      'SELECT rg_track_gain AS gain, rg_track_peak AS peak, rg_source AS source FROM tracks WHERE id = ?'
    )
    .get(trackId)
}

async function settle(job: ReplayGainJobService, jobId: number): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const state = await job.get()
    if (state?.jobId === jobId && state.done) return
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ReplayGain job.')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rg-force-'))
  db = openDatabase(join(dir, 'library.db')).db
  rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', dir, Date.now()).lastInsertRowid
  )
  cleared = []
})

afterEach(async () => {
  await Promise.all(services.splice(0).map((item) => item.close()))
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('forced ReplayGain re-measure (W25-7)', () => {
  it('a forced re-measure overwrites a tag row in the database', async () => {
    const tagged = addTrack('tagged.flac', { source: 'tag', gain: -7.25, peak: 0.91 })
    const job = service(async () => result(-3, 0.5))

    const started = await job.start({ trackIds: [tagged], force: true })
    await settle(job, started.jobId)

    expect(started.total).toBe(1)
    expect(rg(tagged)).toEqual({ gain: -3, peak: 0.5, source: 'computed' })
  })

  it('an unforced scoped measure leaves a tag row alone', async () => {
    const tagged = addTrack('tagged.flac', { source: 'tag', gain: -7.25, peak: 0.91 })
    const bare = addTrack('bare.flac')
    const calls: string[] = []
    const job = service(async (path) => {
      calls.push(basename(path))
      return result(-3, 0.5)
    })

    const started = await job.start({ trackIds: [tagged, bare] })
    await settle(job, started.jobId)

    expect(started.total).toBe(1)
    expect(calls).toEqual(['bare.flac'])
    expect(rg(tagged)).toEqual({ gain: -7.25, peak: 0.91, source: 'tag' })
    expect(rg(bare)).toEqual({ gain: -3, peak: 0.5, source: 'computed' })
  })

  it('keeps the tagged-value race rule for an unforced item', async () => {
    const track = addTrack('race.flac')
    const job = service(async () => {
      // A rescan finds real tags while the worker is decoding.
      db.prepare(
        "UPDATE tracks SET rg_source = 'tag', rg_track_gain = -9, rg_track_peak = 0.4 WHERE id = ?"
      ).run(track)
      return result(-3, 0.5)
    })

    const started = await job.start({ trackIds: [track] })
    await settle(job, started.jobId)

    expect(rg(track)).toEqual({ gain: -9, peak: 0.4, source: 'tag' })
  })

  it('a forced job survives pause and resume under the forced rule', async () => {
    const tagged = addTrack('tagged.flac', { source: 'tag', gain: -7, peak: 0.9 })
    let release: (() => void) | null = null
    const job = service(
      (_path, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve(result(-2, 0.6))
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
    )
    const started = await job.start({ trackIds: [tagged], force: true })
    const cancelled = await job.cancel(started.jobId)
    expect(cancelled.state).toBe('cancelled')
    expect(rg(tagged)).toEqual({ gain: -7, peak: 0.9, source: 'tag' })

    await job.resume(started.jobId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    release!()
    await settle(job, started.jobId)

    expect(rg(tagged)).toEqual({ gain: -2, peak: 0.6, source: 'computed' })
  })

  it('expands an album to every track it has and finalizes the album gain', async () => {
    const albumId = addAlbum('Whole')
    const other = addAlbum('Other')
    const a = addTrack('a.flac', { albumId, source: 'tag', gain: -7, peak: 0.9 })
    const b = addTrack('b.flac', { albumId, source: 'computed', gain: -5, peak: 0.8 })
    const c = addTrack('c.flac', { albumId })
    const elsewhere = addTrack('elsewhere.flac', { albumId: other, source: 'tag', gain: -1 })
    const job = service(async (path) => (basename(path) === 'a.flac' ? result(-8, 0.7) : result()))

    const started = await job.start({ albumIds: [albumId], force: true })
    await settle(job, started.jobId)

    expect(started.total).toBe(3)
    const rows = db
      .prepare(
        'SELECT rg_source AS source, rg_album_gain AS albumGain FROM tracks WHERE album_id = ?'
      )
      .all(albumId) as Array<{ source: string; albumGain: number | null }>
    expect(rows.every((row) => row.source === 'computed')).toBe(true)
    expect(new Set(rows.map((row) => row.albumGain)).size).toBe(1)
    expect(rows[0].albumGain).not.toBeNull()
    expect(rg(elsewhere)).toMatchObject({ gain: -1, source: 'tag' })
    expect(rg(a)).toEqual({ gain: -8, peak: 0.7, source: 'computed' })
    expect(rg(b)).toEqual({ gain: -6, peak: 0.8, source: 'computed' })
    expect(rg(c)).toEqual({ gain: -6, peak: 0.8, source: 'computed' })
  })

  it('drops the staged rows a re-measure makes stale, and says so', async () => {
    const albumId = addAlbum('Staged')
    const a = addTrack('a.flac', { albumId, source: 'computed', gain: -5, peak: 0.8 })
    const b = addTrack('b.flac', { albumId, source: 'computed', gain: -5, peak: 0.8 })
    const stage = db.prepare(
      'INSERT INTO track_tag_overrides (track_id, field, value, updated_at) VALUES (?, ?, ?, 1)'
    )
    stage.run(a, 'replayGainTrackGain', '-5')
    stage.run(b, 'replayGainAlbumGain', '-5')
    stage.run(b, 'title', 'Kept')
    const job = service(async () => result(-4, 0.7))

    // Re-measuring the album lands a new track gain on `a` (its own rows go)
    // and re-finalizes the album gain (every RG row of the album goes).
    const started = await job.start({ albumIds: [albumId], force: true })
    await settle(job, started.jobId)

    expect(db.prepare('SELECT track_id AS trackId, field FROM track_tag_overrides').all()).toEqual([
      { trackId: b, field: 'title' }
    ])
    expect(cleared.flat().sort()).toEqual([a, b].sort())
  })

  it('lets a scoped start supersede a paused job, but not an unscoped one', async () => {
    addTrack('one.flac')
    addTrack('two.flac')
    const target = addTrack('target.flac', { source: 'tag', gain: -7, peak: 0.9 })
    const job = service(
      (_path, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
    )
    const library = await job.start()
    await job.cancel(library.jobId)

    await expect(job.start()).rejects.toThrow(/can be resumed/)
    await services.pop()!.close()

    const scoped = service(async () => result(-1, 0.3))
    const started = await scoped.start({ trackIds: [target], force: true })
    expect(started.jobId).toBeGreaterThan(library.jobId)
    await settle(scoped, started.jobId)
    expect(rg(target)).toEqual({ gain: -1, peak: 0.3, source: 'computed' })

    // The superseded job is no longer the one an unscoped start must resume.
    const fresh = await scoped.start()
    expect(fresh.total).toBe(2)
  })

  it('refuses any start beside a running job', async () => {
    const track = addTrack('slow.flac')
    const job = service(
      (_path, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
    )
    await job.start()
    await expect(job.start({ trackIds: [track], force: true })).rejects.toThrow(/already running/)
  })
})

describe('assertStartReplayGainRequest', () => {
  it('treats null and {} as the whole library', () => {
    expect(assertStartReplayGainRequest(null)).toEqual({})
    expect(assertStartReplayGainRequest({})).toEqual({})
  })

  it('accepts a scope and force', () => {
    expect(assertStartReplayGainRequest({ trackIds: [1], albumIds: [2, 3], force: true })).toEqual({
      trackIds: [1],
      albumIds: [2, 3],
      force: true
    })
  })

  it('rejects bad ids, unknown keys and a non-boolean force', () => {
    expect(() => assertStartReplayGainRequest({ trackIds: [0] })).toThrow()
    expect(() => assertStartReplayGainRequest({ albumIds: 'x' })).toThrow()
    expect(() => assertStartReplayGainRequest({ force: 'yes' })).toThrow()
    expect(() => assertStartReplayGainRequest({ path: '/x' })).toThrow()
  })
})
