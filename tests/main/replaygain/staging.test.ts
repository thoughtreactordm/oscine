import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { assertStageComputedReplayGainRequest } from '../../../src/main/ipc/validate'
import { TagOverrideStore } from '../../../src/main/library/overrides/tagOverrides'
import { ReplayGainJobStore } from '../../../src/main/replaygain/jobStore'
import { ReplayGainStagingService } from '../../../src/main/replaygain/staging'
import { tagField, tagFieldValuesEqual, type TagFieldDef } from '../../../src/shared/tagFields'

let dir: string
let db: ReturnType<typeof openDatabase>['db']
let rootId: number
let staging: ReplayGainStagingService
let overrides: TagOverrideStore

function addAlbum(title: string): number {
  return Number(
    db
      .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, NULL, NULL)')
      .run(title).lastInsertRowid
  )
}

function addTrack(
  name: string,
  options: {
    albumId?: number
    source?: 'tag' | 'computed'
    gain?: number
    peak?: number
    albumGain?: number
    albumPeak?: number
    codec?: string
  } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (
           root_id, rel_path, mtime, size, title, album_id,
           rg_track_gain, rg_track_peak, rg_album_gain, rg_album_peak, rg_source, codec
         ) VALUES (?, ?, 1, 7, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rootId,
        name,
        name,
        options.albumId ?? null,
        options.gain ?? null,
        options.peak ?? null,
        options.albumGain ?? null,
        options.albumPeak ?? null,
        options.source ?? null,
        options.codec ?? null
      ).lastInsertRowid
  )
}

/** A track's staged ReplayGain, as plain field → value. */
function staged(trackId: number): Record<string, unknown> {
  return Object.fromEntries(overrides.get(trackId))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rg-stage-'))
  db = openDatabase(join(dir, 'library.db')).db
  rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', dir, Date.now()).lastInsertRowid
  )
  staging = new ReplayGainStagingService(db)
  overrides = new TagOverrideStore(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ReplayGainStagingService — Decision C', () => {
  it('stages a fully computed album whole', () => {
    const albumId = addAlbum('Whole')
    const computed = { albumId, source: 'computed' as const, albumGain: -7.5, albumPeak: 0.97 }
    const a = addTrack('a.flac', { ...computed, gain: -7, peak: 0.9 })
    const b = addTrack('b.flac', { ...computed, gain: -8, peak: 0.97 })

    const result = staging.stage()

    expect(result).toMatchObject({ stagedAlbums: 1, stagedTracks: 2, skipped: [] })
    expect(staged(a)).toEqual({
      replayGainTrackGain: -7,
      replayGainTrackPeak: 0.9,
      replayGainAlbumGain: -7.5,
      replayGainAlbumPeak: 0.97
    })
    expect(staged(b)).toMatchObject({ replayGainTrackGain: -8, replayGainAlbumGain: -7.5 })
  })

  it('skips an album with an unmeasured track and stages none of it', () => {
    const albumId = addAlbum('Incomplete')
    const measured = addTrack('a.flac', {
      albumId,
      source: 'computed',
      gain: -7,
      peak: 0.9,
      albumGain: -7,
      albumPeak: 0.9
    })
    addTrack('b.flac', { albumId })

    const result = staging.stage()

    expect(result).toMatchObject({ stagedAlbums: 0, stagedTracks: 0 })
    expect(result.skipped).toEqual([{ albumId, reason: 'unmeasured' }])
    expect(staged(measured)).toEqual({})
  })

  it('reports a track the latest job failed as failed', () => {
    const albumId = addAlbum('Failed')
    addTrack('a.flac', { albumId, source: 'computed', gain: -7, peak: 0.9, albumGain: -7 })
    const bad = addTrack('b.flac', { albumId })
    const jobId = Number(
      db
        .prepare(
          "INSERT INTO replaygain_jobs (state, created_at, updated_at) VALUES ('completed', 1, 1)"
        )
        .run().lastInsertRowid
    )
    db.prepare(
      "INSERT INTO replaygain_job_items (job_id, track_id, status, error) VALUES (?, ?, 'failed', 'x')"
    ).run(jobId, bad)

    expect(staging.stage().skipped).toEqual([{ albumId, reason: 'failed' }])
  })

  it('skips a measured album whose album gain was never finalized', () => {
    const albumId = addAlbum('Unfinalized')
    addTrack('a.flac', { albumId, source: 'computed', gain: -7, peak: 0.9 })

    expect(staging.stage().skipped).toEqual([{ albumId, reason: 'missing-album-gain' }])
  })

  it('stages a single as track gain and peak only', () => {
    const single = addTrack('single.flac', {
      source: 'computed',
      gain: -4.25,
      peak: 0.5,
      albumGain: -3
    })

    expect(staging.stage()).toMatchObject({ stagedAlbums: 0, stagedTracks: 1 })
    expect(staged(single)).toEqual({ replayGainTrackGain: -4.25, replayGainTrackPeak: 0.5 })
  })

  it('stages only the named albums, never singles, and reports unknown ids', () => {
    const wanted = addAlbum('Wanted')
    const other = addAlbum('Other')
    const computed = { source: 'computed' as const, gain: -6, peak: 0.8, albumGain: -6 }
    const inWanted = addTrack('w.flac', { ...computed, albumId: wanted })
    const inOther = addTrack('o.flac', { ...computed, albumId: other })
    const single = addTrack('s.flac', computed)

    const result = staging.stage({ albumIds: [wanted, 9999] })

    expect(result).toMatchObject({ stagedAlbums: 1, stagedTracks: 1 })
    expect(result.skipped).toEqual([{ albumId: 9999, reason: 'not-found' }])
    expect(staged(inWanted)).toHaveProperty('replayGainAlbumGain', -6)
    expect(staged(inOther)).toEqual({})
    expect(staged(single)).toEqual({})
  })

  it('reports an all-tagged album as nothing to stage when named', () => {
    const albumId = addAlbum('Tagged')
    addTrack('t.flac', { albumId, source: 'tag', gain: -5, albumGain: -5 })

    expect(staging.stage({ albumIds: [albumId] }).skipped).toEqual([
      { albumId, reason: 'nothing-measured' }
    ])
  })
})

describe('ReplayGainStagingService — Decision D (mixed albums)', () => {
  function mixedAlbum(taggedAlbumGain: number | undefined): {
    computedId: number
    taggedId: number
  } {
    const albumId = addAlbum('Mixed')
    const computedId = addTrack('c.flac', {
      albumId,
      source: 'computed',
      gain: -8,
      peak: 0.95,
      albumGain: -7.5,
      albumPeak: 0.95
    })
    const taggedId = addTrack('t.flac', {
      albumId,
      source: 'tag',
      gain: -7,
      peak: 0.9,
      ...(taggedAlbumGain !== undefined ? { albumGain: taggedAlbumGain, albumPeak: 0.9 } : {})
    })
    return { computedId, taggedId }
  }

  it('fills a tagged track that has no album gain, never its track gain', () => {
    const { computedId, taggedId } = mixedAlbum(undefined)

    expect(staging.stage()).toMatchObject({ stagedAlbums: 1, stagedTracks: 2 })
    expect(staged(computedId)).toHaveProperty('replayGainTrackGain', -8)
    expect(staged(taggedId)).toEqual({ replayGainAlbumGain: -7.5, replayGainAlbumPeak: 0.95 })
  })

  it('leaves a tagged track alone when its album gain matches within 0.1 dB', () => {
    const { computedId, taggedId } = mixedAlbum(-7.45)

    expect(staging.stage()).toMatchObject({ stagedAlbums: 1, stagedTracks: 1 })
    expect(staged(computedId)).toHaveProperty('replayGainAlbumGain', -7.5)
    expect(staged(taggedId)).toEqual({})
  })

  it('stages a differing tagged album gain for the review to show deselected', () => {
    const { taggedId } = mixedAlbum(-6)

    expect(staging.stage()).toMatchObject({ stagedAlbums: 1, stagedTracks: 2 })
    // No track gain: the file's own stays. The review derives "deselected"
    // from the > 0.1 dB difference against the file; nothing is stored.
    expect(staged(taggedId)).toEqual({ replayGainAlbumGain: -7.5, replayGainAlbumPeak: 0.95 })
  })

  it('re-staging replaces the album snapshot instead of accumulating', () => {
    const { taggedId } = mixedAlbum(-6)
    staging.stage()
    // The file gained a matching album gain since (a rescan); re-staging drops
    // the now-unneeded row rather than leaving the old one behind.
    db.prepare('UPDATE tracks SET rg_album_gain = -7.5 WHERE id = ?').run(taggedId)

    staging.stage()

    expect(staged(taggedId)).toEqual({})
  })
})

describe('ReplayGainStagingService — Decision E (Opus)', () => {
  it('stages an Opus track gains only: R128 has no peak tag', () => {
    const albumId = addAlbum('Opus')
    const computed = { albumId, source: 'computed' as const, albumGain: -7.5, albumPeak: 0.97 }
    const opus = addTrack('a.opus', { ...computed, gain: -7, peak: 0.9, codec: 'opus' })
    const flac = addTrack('b.flac', { ...computed, gain: -8, peak: 0.97, codec: 'flac' })
    const tagged = addTrack('c.opus', { albumId, source: 'tag', gain: -6, codec: 'opus' })
    const single = addTrack('d.opus', { source: 'computed', gain: -5, peak: 0.8, codec: 'opus' })

    expect(staging.stage()).toMatchObject({ stagedAlbums: 1, stagedTracks: 4 })
    expect(staged(opus)).toEqual({ replayGainTrackGain: -7, replayGainAlbumGain: -7.5 })
    expect(staged(flac)).toEqual({
      replayGainTrackGain: -8,
      replayGainTrackPeak: 0.97,
      replayGainAlbumGain: -7.5,
      replayGainAlbumPeak: 0.97
    })
    expect(staged(tagged)).toEqual({ replayGainAlbumGain: -7.5 })
    expect(staged(single)).toEqual({ replayGainTrackGain: -5 })
  })
})

describe('ReplayGainStagingService — Decision F', () => {
  it('drops a track’s staged rows in the same transaction as its re-measure', () => {
    const albumId = addAlbum('Remeasure')
    const computed = { albumId, source: 'computed' as const, albumGain: -6, albumPeak: 0.99 }
    const first = addTrack('first.flac', { ...computed, gain: -6, peak: 0.8 })
    const second = addTrack('second.flac', { ...computed, gain: -9, peak: 0.99 })
    const tagged = addTrack('tagged.flac', { albumId, source: 'tag', gain: -7, peak: 0.5 })
    staging.stage()
    expect(staged(first)).toHaveProperty('replayGainTrackGain', -6)
    expect(staged(tagged)).toHaveProperty('replayGainAlbumGain', -6)
    // A hand-staged generic correction on the same track is not ReplayGain's to drop.
    overrides.set([first], { comment: 'keep me' }, 1)

    // RG-7's forced re-measure resets the source; the job then re-queues them.
    db.prepare("UPDATE tracks SET rg_source = NULL WHERE rg_source = 'computed'").run()
    const store = new ReplayGainJobStore(db)
    const job = store.createJob()
    const one = store.claimNext(job.jobId)!
    expect(one.trackId).toBe(first)
    store.complete(one, { trackGainDb: -5, trackPeak: 0.7, histogram: [[130, 10]] })

    expect(staged(first)).toEqual({ comment: 'keep me' })
    // Not re-measured yet: its snapshot stays until its own measurement lands.
    expect(staged(second)).toHaveProperty('replayGainTrackGain', -9)

    const two = store.claimNext(job.jobId)!
    store.complete(two, { trackGainDb: -8, trackPeak: 0.9, histogram: [[100, 10]] })
    expect(staged(second)).toEqual({})
    expect(staged(tagged)).toHaveProperty('replayGainAlbumGain', -6)

    // Re-finalizing the album invalidates the rest of it: the tagged track's
    // filled-in album gain is stale too.
    store.finalizeAlbums(job.jobId)
    expect(staged(tagged)).toEqual({})

    // Re-staging after the re-measure offers the fresh values.
    staging.stage()
    expect(staged(first)).toMatchObject({ replayGainTrackGain: -5, replayGainTrackPeak: 0.7 })
    expect(staged(tagged).replayGainAlbumGain).not.toBe(-6)
  })

  it('compares staged and file values within tolerance', () => {
    const gain = tagField('replayGainTrackGain') as TagFieldDef
    const peak = tagField('replayGainAlbumPeak') as TagFieldDef
    // A gain read back as two decimals is the value that was staged.
    expect(tagFieldValuesEqual(gain, -7.234, -7.23)).toBe(true)
    expect(tagFieldValuesEqual(gain, -7.234, -7.239)).toBe(true)
    expect(tagFieldValuesEqual(gain, -7.234, -7.24)).toBe(false)
    expect(tagFieldValuesEqual(peak, 0.9876541, 0.987654)).toBe(true)
    expect(tagFieldValuesEqual(peak, 0.987656, 0.987654)).toBe(false)
    expect(tagFieldValuesEqual(gain, -7.23, null)).toBe(false)
    // Non-real fields stay exact.
    const text = tagField('comment') as TagFieldDef
    expect(tagFieldValuesEqual(text, 'a', 'a')).toBe(true)
    expect(tagFieldValuesEqual(text, 'a', 'b')).toBe(false)
  })
})

describe('library.stageComputedReplayGain request', () => {
  it('accepts no albumIds or a positive id list, and rejects anything else', () => {
    expect(assertStageComputedReplayGainRequest({})).toEqual({})
    expect(assertStageComputedReplayGainRequest({ albumIds: [1, 2] })).toEqual({
      albumIds: [1, 2]
    })
    expect(() => assertStageComputedReplayGainRequest({ albumIds: [0] })).toThrow()
    expect(() => assertStageComputedReplayGainRequest({ albumIds: 'all' })).toThrow()
    expect(() => assertStageComputedReplayGainRequest({ other: true })).toThrow()
    expect(() => assertStageComputedReplayGainRequest(null)).toThrow()
  })
})
