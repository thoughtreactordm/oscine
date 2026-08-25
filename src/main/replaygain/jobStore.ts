import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import type { ReplayGainJobProgress, ReplayGainJobState } from '@shared/library'
import { toAbsPath } from '../db/paths'
import {
  gainFromHistogram,
  mergeHistograms,
  type LoudnessHistogram,
  type ReplayGainAnalysis
} from './loudness'

export interface ReplayGainWorkItem {
  jobId: number
  trackId: number
  title: string
  path: string | null
}

interface JobRow {
  id: number
  state: ReplayGainJobState
  createdAt: number
  updatedAt: number
}

interface ProgressRow extends JobRow {
  total: number
  completed: number
  failed: number
  pending: number
}

const PROGRESS_SQL = `
  SELECT j.id AS id, j.state AS state, j.created_at AS createdAt,
         j.updated_at AS updatedAt,
         count(i.track_id) AS total,
         coalesce(sum(i.status = 'completed'), 0) AS completed,
         coalesce(sum(i.status = 'failed'), 0) AS failed,
         coalesce(sum(i.status IN ('pending', 'running')), 0) AS pending
  FROM replaygain_jobs j
  LEFT JOIN replaygain_job_items i ON i.job_id = j.id
`

export class ReplayGainJobStore {
  constructor(private readonly db: Database.Database) {}

  recoverInterrupted(): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE replaygain_job_items SET status = 'pending' WHERE status = 'running' AND job_id IN (SELECT id FROM replaygain_jobs WHERE state IN ('running', 'cancelling'))"
        )
        .run()
      this.db
        .prepare(
          "UPDATE replaygain_jobs SET state = 'paused', updated_at = ? WHERE state IN ('running', 'cancelling')"
        )
        .run(Date.now())
    })()
  }

  createJob(): ReplayGainJobProgress {
    const existing = this.db
      .prepare(
        "SELECT id FROM replaygain_jobs WHERE state IN ('running', 'cancelling', 'paused', 'cancelled') ORDER BY id DESC LIMIT 1"
      )
      .get() as { id: number } | undefined
    if (existing) {
      throw new OscineError(
        'conflict',
        `ReplayGain job ${existing.id} can be resumed instead of starting another.`
      )
    }

    const now = Date.now()
    const id = this.db.transaction(() => {
      const jobId = Number(
        this.db
          .prepare(
            "INSERT INTO replaygain_jobs (state, created_at, updated_at) VALUES ('running', ?, ?)"
          )
          .run(now, now).lastInsertRowid
      )
      this.db
        .prepare(
          `INSERT INTO replaygain_job_items (job_id, track_id, status)
           SELECT ?, id, 'pending'
           FROM tracks
           WHERE rg_source IS NULL
           ORDER BY id`
        )
        .run(jobId)
      return jobId
    })()
    return this.progress(id)
  }

  latestProgress(): ReplayGainJobProgress | null {
    const row = this.db
      .prepare(`${PROGRESS_SQL} GROUP BY j.id ORDER BY j.id DESC LIMIT 1`)
      .get() as ProgressRow | undefined
    return row ? toProgress(row) : null
  }

  progress(jobId: number, currentTitle: string | null = null): ReplayGainJobProgress {
    const row = this.db.prepare(`${PROGRESS_SQL} WHERE j.id = ? GROUP BY j.id`).get(jobId) as
      ProgressRow | undefined
    if (!row) throw new OscineError('not-found', 'That ReplayGain job no longer exists.')
    return toProgress(row, currentTitle)
  }

  state(jobId: number): ReplayGainJobState {
    const row = this.db.prepare('SELECT state FROM replaygain_jobs WHERE id = ?').get(jobId) as
      { state: ReplayGainJobState } | undefined
    if (!row) throw new OscineError('not-found', 'That ReplayGain job no longer exists.')
    return row.state
  }

  setState(jobId: number, state: ReplayGainJobState): void {
    const changed = this.db
      .prepare('UPDATE replaygain_jobs SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, Date.now(), jobId).changes
    if (changed === 0) {
      throw new OscineError('not-found', 'That ReplayGain job no longer exists.')
    }
  }

  pause(jobId: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE replaygain_job_items SET status = 'pending' WHERE job_id = ? AND status = 'running'"
        )
        .run(jobId)
      this.setState(jobId, 'paused')
    })()
  }

  claimNext(jobId: number): ReplayGainWorkItem | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT i.track_id AS trackId, t.title AS title,
                  r.path AS rootPath, t.rel_path AS relPath
           FROM replaygain_job_items i
           JOIN tracks t ON t.id = i.track_id
           JOIN roots r ON r.id = t.root_id
           WHERE i.job_id = ? AND i.status = 'pending'
           ORDER BY i.track_id
           LIMIT 1`
        )
        .get(jobId) as
        { trackId: number; title: string | null; rootPath: string; relPath: string } | undefined
      if (!row) return null
      this.db
        .prepare(
          "UPDATE replaygain_job_items SET status = 'running' WHERE job_id = ? AND track_id = ?"
        )
        .run(jobId, row.trackId)
      return {
        jobId,
        trackId: row.trackId,
        title: row.title ?? '',
        path: toAbsPath(row.rootPath, row.relPath)
      }
    })()
  }

  complete(item: ReplayGainWorkItem, result: ReplayGainAnalysis): void {
    this.db.transaction(() => {
      // The guard is the tagged-value race rule. If a rescan found real tags
      // while analysis was running, the worker result loses without touching a
      // byte of authoritative ReplayGain data.
      this.db
        .prepare(
          `UPDATE tracks
           SET rg_track_gain = ?, rg_track_peak = ?, rg_source = 'computed'
           WHERE id = ? AND rg_source IS NULL`
        )
        .run(result.trackGainDb, result.trackPeak, item.trackId)
      this.db
        .prepare(
          `UPDATE replaygain_job_items
           SET status = 'completed', loudness_histogram = ?, peak = ?, error = NULL
           WHERE job_id = ? AND track_id = ?`
        )
        .run(JSON.stringify(result.histogram), result.trackPeak, item.jobId, item.trackId)
      this.touch(item.jobId)
    })()
  }

  fail(item: ReplayGainWorkItem, safeError: string): void {
    this.db
      .prepare(
        `UPDATE replaygain_job_items
         SET status = 'failed', error = ?
         WHERE job_id = ? AND track_id = ?`
      )
      .run(safeError, item.jobId, item.trackId)
    this.touch(item.jobId)
  }

  returnToPending(item: ReplayGainWorkItem): void {
    this.db
      .prepare(
        "UPDATE replaygain_job_items SET status = 'pending' WHERE job_id = ? AND track_id = ? AND status = 'running'"
      )
      .run(item.jobId, item.trackId)
    this.touch(item.jobId)
  }

  finalizeAlbums(jobId: number): void {
    const albumIds = this.db
      .prepare(
        `SELECT DISTINCT t.album_id AS albumId
         FROM replaygain_job_items i
         JOIN tracks t ON t.id = i.track_id
         WHERE i.job_id = ? AND t.album_id IS NOT NULL AND i.status = 'completed'`
      )
      .all(jobId) as Array<{ albumId: number }>

    for (const { albumId } of albumIds) this.finalizeAlbum(albumId)
  }

  private finalizeAlbum(albumId: number): void {
    const rows = this.db
      .prepare(
        `SELECT t.id AS trackId, t.rg_source AS source,
                t.rg_track_gain AS trackGain, t.rg_track_peak AS trackPeak,
                t.duration_ms AS durationMs,
                (SELECT i.loudness_histogram
                   FROM replaygain_job_items i
                  WHERE i.track_id = t.id AND i.status = 'completed'
                    AND i.loudness_histogram IS NOT NULL
                  ORDER BY i.job_id DESC LIMIT 1) AS histogram
         FROM tracks t
         WHERE t.album_id = ?`
      )
      .all(albumId) as Array<{
      trackId: number
      source: 'tag' | 'computed' | null
      trackGain: number | null
      trackPeak: number | null
      durationMs: number | null
      histogram: string | null
    }>

    if (
      rows.length === 0 ||
      rows.some(
        (row) =>
          row.source === null ||
          row.trackGain === null ||
          (row.source === 'computed' && row.histogram === null)
      )
    ) {
      return
    }

    const histograms: LoudnessHistogram[] = rows.map((row) => {
      if (row.histogram) return JSON.parse(row.histogram) as LoudnessHistogram
      // Tagged tracks were intentionally not decoded. Their gain still gives
      // their integrated loudness, represented as one weighted histogram bin.
      const durationBlocks =
        row.durationMs === null
          ? 1
          : Math.max(1, Math.floor((Math.max(400, row.durationMs) - 400) / 100) + 1)
      return [[Math.round((-18 - row.trackGain!) * 10), durationBlocks]]
    })
    const albumGain = gainFromHistogram(mergeHistograms(histograms))
    if (albumGain === null) return
    const albumPeak = Math.max(...rows.map((row) => row.trackPeak ?? 0))
    this.db
      .prepare(
        `UPDATE tracks
         SET rg_album_gain = ?, rg_album_peak = ?
         WHERE album_id = ? AND rg_source = 'computed'`
      )
      .run(albumGain, albumPeak, albumId)
  }

  private touch(jobId: number): void {
    this.db.prepare('UPDATE replaygain_jobs SET updated_at = ? WHERE id = ?').run(Date.now(), jobId)
  }
}

function toProgress(row: ProgressRow, currentTitle: string | null = null): ReplayGainJobProgress {
  return {
    jobId: row.id,
    state: row.state,
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    pending: row.pending,
    currentTitle,
    updatedAt: new Date(row.updatedAt).toISOString(),
    done: row.state === 'cancelled' || row.state === 'completed'
  }
}
