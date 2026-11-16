import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import type { ReplayGainAnalyzer } from '../../../src/main/replaygain/analyzer'
import { ReplayGainJobService } from '../../../src/main/replaygain/jobService'
import type { ReplayGainAnalysis } from '../../../src/main/replaygain/loudness'
import type { ReplayGainJobProgress } from '../../../src/shared/library'

let dir: string
let databasePath: string
let db: ReturnType<typeof openDatabase>['db']
let rootId: number
const services: ReplayGainJobService[] = []

function result(gain = -6, peak = 0.8): ReplayGainAnalysis {
  return {
    trackGainDb: gain,
    trackPeak: peak,
    histogram: [[Math.round((-18 - gain) * 10), 1]]
  }
}

function analyzer(
  analyze: (path: string, signal: AbortSignal) => Promise<ReplayGainAnalysis>
): ReplayGainAnalyzer {
  return { analyze, close: async () => {} }
}

function service(
  createAnalyzer: () => ReplayGainAnalyzer,
  canCompute?: () => boolean
): ReplayGainJobService {
  const instance = new ReplayGainJobService({
    db,
    onProgress: () => {},
    createAnalyzer,
    ...(canCompute ? { canCompute } : {})
  })
  services.push(instance)
  return instance
}

function addTrack(
  name: string,
  options: {
    albumId?: number
    source?: 'tag' | 'computed'
    gain?: number
    peak?: number
  } = {}
): number {
  writeFileSync(join(dir, name), 'fixture')
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (
           root_id, rel_path, mtime, size, title, album_id,
           rg_track_gain, rg_track_peak, rg_source
         ) VALUES (?, ?, 1, 7, ?, ?, ?, ?, ?)`
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

async function waitFor(
  job: ReplayGainJobService,
  predicate: (state: Awaited<ReturnType<ReplayGainJobService['get']>>) => boolean
): Promise<NonNullable<Awaited<ReturnType<ReplayGainJobService['get']>>>> {
  // Wall-clock deadline, not a poll count: a count-based cap silently assumes
  // each poll is ~fast, so on a loaded CI runner the job can still be running
  // when the attempts run out. Bound by elapsed time instead.
  const deadline = Date.now() + 5_000
  for (;;) {
    const state = await job.get()
    if (state && predicate(state)) return state
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ReplayGain job.')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rg-'))
  mkdirSync(dir, { recursive: true })
  databasePath = join(dir, 'library.db')
  db = openDatabase(databasePath).db
  rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', dir, Date.now()).lastInsertRowid
  )
})

afterEach(async () => {
  await Promise.all(services.splice(0).map((item) => item.close()))
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ReplayGainJobService', () => {
  it('skips tagged rows byte-for-byte and checkpoints computed rows', async () => {
    const tagged = addTrack('tagged.flac', {
      source: 'tag',
      gain: -7.25,
      peak: 0.91
    })
    const bare = addTrack('bare.flac')
    const calls: string[] = []
    const job = service(() =>
      analyzer(async (path) => {
        calls.push(basename(path))
        return result()
      })
    )

    const started = await job.start()
    const done = await waitFor(job, (state) => state?.state === 'completed')

    expect(started.total).toBe(1)
    expect(done).toMatchObject({ completed: 1, failed: 0, pending: 0 })
    expect(calls).toEqual(['bare.flac'])
    expect(db.prepare('SELECT * FROM tracks WHERE id = ?').get(tagged)).toMatchObject({
      rg_track_gain: -7.25,
      rg_track_peak: 0.91,
      rg_source: 'tag'
    })
    expect(db.prepare('SELECT * FROM tracks WHERE id = ?').get(bare)).toMatchObject({
      rg_track_gain: -6,
      rg_track_peak: 0.8,
      rg_source: 'computed'
    })
  })

  it('bounds analysis concurrency at two workers', async () => {
    for (let index = 0; index < 30; index++) addTrack(`${index}.flac`)
    let active = 0
    let maximum = 0
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 0)
    const job = service(() =>
      analyzer(async () => {
        active++
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 3))
        active--
        return result()
      })
    )

    await job.start()
    await waitFor(job, (state) => state?.state === 'completed')

    expect(maximum).toBe(2)
    expect(timerFired).toBe(true)
  })

  it('records a per-file failure and retries it only in a fresh job', async () => {
    const albumId = Number(
      db
        .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, NULL, NULL)')
        .run('Retry').lastInsertRowid
    )
    const goodId = addTrack('good.flac', { albumId })
    addTrack('bad.flac', { albumId })
    let failBad = true
    const create = (): ReplayGainAnalyzer =>
      analyzer(async (path) => {
        if (basename(path) === 'bad.flac' && failBad) throw new Error(`cannot decode ${path}`)
        return result()
      })
    const first = service(create)

    await first.start()
    const failed = await waitFor(first, (state) => state?.state === 'completed')
    expect(failed).toMatchObject({ completed: 1, failed: 1 })
    const stored = db
      .prepare("SELECT error FROM replaygain_job_items WHERE status = 'failed'")
      .get() as { error: string }
    expect(stored.error).not.toContain(dir)
    expect(db.prepare('SELECT rg_album_gain AS gain FROM tracks WHERE id = ?').get(goodId)).toEqual(
      { gain: null }
    )

    failBad = false
    const retry = await first.start()
    expect(retry.total).toBe(1)
    await waitFor(first, (state) => state?.jobId === retry.jobId && state.state === 'completed')
    expect(
      db.prepare("SELECT count(*) AS n FROM tracks WHERE rg_source = 'computed'").get()
    ).toEqual({
      n: 2
    })
    expect(
      db.prepare('SELECT count(*) AS n FROM tracks WHERE rg_album_gain IS NOT NULL').get()
    ).toEqual({ n: 2 })
  })

  it('cancels promptly and resumes without recomputing a completed checkpoint', async () => {
    addTrack('first.flac')
    addTrack('second.flac')
    addTrack('third.flac')
    const calls = new Map<string, number>()
    const slow = (): ReplayGainAnalyzer =>
      analyzer(async (path, signal) => {
        const name = basename(path)
        calls.set(name, (calls.get(name) ?? 0) + 1)
        if (name === 'first.flac') return result()
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(result()), 200)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              reject(new Error('cancelled'))
            },
            { once: true }
          )
        })
      })
    const firstProcess = service(slow)
    const started = await firstProcess.start()
    await waitFor(firstProcess, (state) => (state?.completed ?? 0) >= 1)
    const cancelled = await firstProcess.cancel(started.jobId)

    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.completed).toBe(1)
    expect(cancelled.pending).toBe(2)

    // A real connection close/reopen proves the checkpoint is in SQLite, not
    // merely retained in the service instance.
    await firstProcess.close()
    db.close()
    db = openDatabase(databasePath).db

    const resumedProcess = service(() =>
      analyzer(async (path) => {
        const name = basename(path)
        calls.set(name, (calls.get(name) ?? 0) + 1)
        return result()
      })
    )
    await resumedProcess.resume(started.jobId)
    await waitFor(resumedProcess, (state) => state?.state === 'completed')

    expect(calls.get('first.flac')).toBe(1)
    expect(
      db.prepare("SELECT count(*) AS n FROM tracks WHERE rg_source = 'computed'").get()
    ).toEqual({ n: 3 })
  })

  it('writes album values only after every untagged member succeeds', async () => {
    const albumId = Number(
      db
        .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, NULL, NULL)')
        .run('Complete').lastInsertRowid
    )
    const first = addTrack('a.flac', { albumId })
    const second = addTrack('b.flac', { albumId })
    const job = service(() =>
      analyzer(async (path) => (basename(path) === 'a.flac' ? result(-8, 0.7) : result(-4, 0.95)))
    )

    await job.start()
    await waitFor(job, (state) => state?.state === 'completed')

    const rows = db
      .prepare(
        'SELECT id, rg_album_gain AS albumGain, rg_album_peak AS albumPeak FROM tracks WHERE id IN (?, ?) ORDER BY id'
      )
      .all(first, second) as Array<{ albumGain: number | null; albumPeak: number | null }>
    expect(rows[0].albumGain).not.toBeNull()
    expect(rows[0].albumGain).toBe(rows[1].albumGain)
    expect(rows[0].albumPeak).toBe(0.95)
    expect(rows[1].albumPeak).toBe(0.95)
  })

  /**
   * `audio.replayGainComputeWhenMissing`, the one audio key whose consumer is in
   * main rather than in the renderer.
   *
   * It refuses rather than returning an empty completed job, because an empty
   * completed job is indistinguishable from a library that is already fully
   * analysed — and the operator would then go looking for tracks the job had
   * never been allowed to touch.
   */
  describe('the compute-when-missing gate', () => {
    it('refuses to start while the setting is off', async () => {
      addTrack('untagged.flac')
      const job = service(
        () => analyzer(async () => result()),
        () => false
      )

      await expect(job.start()).rejects.toThrow(/turned off in audio settings/)
      expect(await job.get()).toBeNull()
    })

    it('refuses to resume a paused job while the setting is off', async () => {
      addTrack('untagged.flac')
      let allowed = true
      const job = service(
        () => analyzer(async () => result()),
        () => allowed
      )

      const started = await job.start()
      await job.cancel(started.jobId)
      allowed = false

      await expect(job.resume(started.jobId)).rejects.toThrow(/turned off in audio settings/)
    })

    it('reads the setting at the moment it is asked, not at construction', async () => {
      // Turned off after the service was built. A boolean captured in the
      // constructor would have been one this service never heard change.
      addTrack('untagged.flac')
      let allowed = true
      const job = service(
        () => analyzer(async () => result()),
        () => allowed
      )

      allowed = false
      await expect(job.start()).rejects.toThrow(/turned off in audio settings/)

      allowed = true
      await expect(job.start()).resolves.toMatchObject({ total: 1 })
    })

    it('runs as it always did when nothing gates it', async () => {
      addTrack('untagged.flac')
      const job = service(() => analyzer(async () => result()))

      await expect(job.start()).resolves.toMatchObject({ total: 1 })
    })
  })

  /**
   * W25-1: the stream a UI subscribes to. Per-track events are coalesced in
   * main; state transitions are not, because they are what a Cancel or Resume
   * control is waiting on.
   */
  describe('progress throttling', () => {
    function recording(
      createAnalyzer: () => ReplayGainAnalyzer,
      progressIntervalMs: number
    ): { job: ReplayGainJobService; events: ReplayGainJobProgress[] } {
      const events: ReplayGainJobProgress[] = []
      const job = new ReplayGainJobService({
        db,
        onProgress: (progress) => events.push(progress),
        createAnalyzer,
        progressIntervalMs
      })
      services.push(job)
      return { job, events }
    }

    it('coalesces per-track events and always delivers the terminal one', async () => {
      for (let index = 0; index < 40; index++) addTrack(`${index}.flac`)
      const { job, events } = recording(() => analyzer(async () => result()), 60_000)

      await job.start()
      await waitFor(job, (state) => state?.state === 'completed')

      // Forty tracks would be eighty unthrottled events (claim + checkpoint).
      expect(events.length).toBeLessThanOrEqual(4)
      expect(events.at(-1)).toMatchObject({ state: 'completed', completed: 40, done: true })
      expect(events.at(-1)?.currentTitle).toBeNull()
    })

    it('sends a trailing event so the last count of a burst is not dropped', async () => {
      addTrack('a.flac')
      addTrack('b.flac')
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const { job, events } = recording(
        () =>
          analyzer(async (path) => {
            if (basename(path) === 'b.flac') await gate
            return result()
          }),
        20
      )

      await job.start()
      // a.flac checkpoints inside the window; only the trailing event reports it.
      const deadline = Date.now() + 5_000
      while (!events.some((event) => event.state === 'running' && event.completed === 1)) {
        if (Date.now() >= deadline) throw new Error('No trailing progress event.')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const trailing = events.find((event) => event.completed === 1)
      expect(trailing?.currentTitle).not.toBeNull()
      release()
      await waitFor(job, (state) => state?.state === 'completed')
    })

    it('never holds back a cancel behind the throttle', async () => {
      addTrack('one.flac')
      addTrack('two.flac')
      const { job, events } = recording(
        () =>
          analyzer(
            (_path, signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(new Error('cancelled')), {
                  once: true
                })
              })
          ),
        60_000
      )

      const started = await job.start()
      await job.cancel(started.jobId)

      const states = events.map((event) => event.state)
      expect(states).toContain('cancelling')
      expect(states.at(-1)).toBe('cancelled')
      expect(events.at(-1)?.currentTitle).toBeNull()
    })
  })

  describe('summary', () => {
    it('counts tagged, computed and missing over tracks', async () => {
      addTrack('tagged.flac', { source: 'tag', gain: -7, peak: 0.9 })
      addTrack('measured.flac', { source: 'computed', gain: -5, peak: 0.8 })
      addTrack('bare-1.flac')
      addTrack('bare-2.flac')
      const job = service(() => analyzer(async () => result()))

      expect(await job.summary()).toEqual({ tagged: 1, computed: 1, missing: 2, failed: 0 })
    })

    it('reports failures from the latest job only, as a subset of missing', async () => {
      addTrack('good.flac')
      addTrack('bad.flac')
      let failBad = true
      const job = service(() =>
        analyzer(async (path) => {
          if (basename(path) === 'bad.flac' && failBad) throw new Error('cannot decode')
          return result()
        })
      )

      await job.start()
      await waitFor(job, (state) => state?.state === 'completed')
      expect(await job.summary()).toEqual({ tagged: 0, computed: 1, missing: 1, failed: 1 })

      failBad = false
      const retry = await job.start()
      await waitFor(job, (state) => state?.jobId === retry.jobId && state.state === 'completed')
      expect(await job.summary()).toEqual({ tagged: 0, computed: 2, missing: 0, failed: 0 })
    })

    it('drops a failure a rescan has since resolved with a real tag', async () => {
      const bad = addTrack('bad.flac')
      const job = service(() =>
        analyzer(async () => {
          throw new Error('cannot decode')
        })
      )
      await job.start()
      await waitFor(job, (state) => state?.state === 'completed')

      db.prepare(
        "UPDATE tracks SET rg_source = 'tag', rg_track_gain = -6, rg_track_peak = 0.9 WHERE id = ?"
      ).run(bad)

      expect(await job.summary()).toEqual({ tagged: 1, computed: 0, missing: 0, failed: 0 })
    })

    it('never sees a podcast episode (OQ3: episodes are not rows in tracks)', async () => {
      addTrack('song.flac')
      const podcastId = Number(
        db
          .prepare('INSERT INTO podcasts (feed_url, title, subscribed_at) VALUES (?, ?, ?)')
          .run('https://example.invalid/feed.xml', 'Show', Date.now()).lastInsertRowid
      )
      db.prepare(
        `INSERT INTO episodes (podcast_id, guid, title, enclosure_url, rel_path, downloaded_at)
         VALUES (?, 'ep-1', 'Episode', 'https://example.invalid/ep.mp3', 'show/ep.mp3', ?)`
      ).run(podcastId, Date.now())
      const job = service(() => analyzer(async () => result()))

      expect(await job.summary()).toEqual({ tagged: 0, computed: 0, missing: 1, failed: 0 })
      expect((await job.start()).total).toBe(1)
    })
  })
})
