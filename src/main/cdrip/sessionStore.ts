import type { RipCover } from './artwork'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import type {
  CdToc,
  RipFailureCode,
  RipOutcome,
  RipOutcomeStatus,
  RipResumeOffer,
  RipSessionState
} from '@shared/cdrip'

/**
 * Durable rip checkpoints — **W18-8**.
 *
 * Persist first, act second. A `pending` track row written before the encoder
 * runs is what makes a crash mid-track recoverable; a row written only on
 * success is a row that is not there when the power goes.
 *
 * Resume is offered, never automatic. The disc may be gone, and spinning a
 * drive at launch is hostile. `toc_hash` is the resume gate: a different disc
 * in the tray is refused rather than interleaved into the same folder.
 */

export const RIP_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const RIP_SESSION_CAP = 50

const WIN_SEP = String.fromCharCode(0x5c)

export type RipSessionTrackStatus = RipOutcomeStatus | 'pending'

export interface RipSessionTrackRecord {
  sessionId: number
  trackNumber: number
  title: string
  artist: string
  relPath: string
  status: RipSessionTrackStatus
  sha256: string | null
  attempts: number
  errorCode: RipFailureCode | null
}

export interface RipSessionRecord {
  id: number
  discId: string
  tocHash: string
  releaseMbid: string | null
  rootId: number
  relDir: string
  template: string
  album: string
  albumArtist: string
  year: number | null
  verify: boolean
  artwork?: RipCover | null
  state: RipSessionState
  createdAt: number
  updatedAt: number
  tracks: RipSessionTrackRecord[]
}

export interface RipSessionCreateTrack {
  number: number
  title: string
  artist: string
  relPath: string
}

export interface RipSessionCreate {
  discId: string
  tocHash: string
  releaseMbid: string | null
  rootId: number
  relDir: string
  template: string
  album: string
  albumArtist: string
  year: number | null
  verify: boolean
  artwork?: RipCover | null
  tracks: readonly RipSessionCreateTrack[]
}

/**
 * Canonical SHA-256 of the TOC identity: track numbers, start sectors, audio
 * flags, and lead-out. CD-TEXT is excluded so a disc that gained or lost a
 * text block is still the same disc. `sectorCount` is excluded because the
 * rip range is consecutive offsets, not the TOC's own counts.
 */
export function hashToc(toc: CdToc): string {
  const payload = [
    toc.firstTrack,
    toc.lastTrack,
    toc.leadOutSector,
    ...toc.entries.flatMap((entry) => [entry.number, entry.startSector, entry.isAudio ? 1 : 0])
  ].join(':')
  return createHash('sha256').update(payload).digest('hex')
}

export class RipSessionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {
    this.prune()
  }

  /**
   * Drop finished sessions older than 30 days, then cap the table. A
   * `running` row is never deleted — that is the crash still waiting on the
   * disc in the tray.
   */
  prune(): void {
    const now = this.now()
    this.db
      .prepare(
        `DELETE FROM rip_sessions
          WHERE state != 'running'
            AND updated_at < ?`
      )
      .run(now - RIP_SESSION_MAX_AGE_MS)

    const total = (this.db.prepare('SELECT count(*) AS n FROM rip_sessions').get() as { n: number })
      .n
    if (total <= RIP_SESSION_CAP) return
    const extra = total - RIP_SESSION_CAP
    const ids = this.db
      .prepare(
        `SELECT id FROM rip_sessions
          WHERE state != 'running'
          ORDER BY updated_at ASC, id ASC
          LIMIT ?`
      )
      .all(extra) as { id: number }[]
    if (ids.length === 0) return
    const del = this.db.prepare('DELETE FROM rip_sessions WHERE id = ?')
    this.db.transaction(() => {
      for (const row of ids) del.run(row.id)
    })()
  }

  create(input: RipSessionCreate): number {
    if (input.tracks.length === 0) {
      throw new OscineError('invalid-request', 'A rip session needs at least one track.')
    }
    const now = this.now()
    return this.db.transaction(() => {
      const sessionId = Number(
        this.db
          .prepare(
            `INSERT INTO rip_sessions (
               disc_id, toc_hash, release_mbid, root_id, rel_dir, template,
               album, album_artist, year, verify, state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`
          )
          .run(
            input.discId,
            input.tocHash,
            input.releaseMbid,
            input.rootId,
            input.relDir,
            input.template,
            input.album,
            input.albumArtist,
            input.year,
            input.verify ? 1 : 0,
            now,
            now
          ).lastInsertRowid
      )
      if (input.artwork) {
        this.db
          .prepare('UPDATE rip_sessions SET artwork_bytes = ?, artwork_mime = ? WHERE id = ?')
          .run(input.artwork.bytes, input.artwork.mime, sessionId)
      }
      const insert = this.db.prepare(
        `INSERT INTO rip_session_tracks (
           session_id, track_number, title, artist, rel_path, status
         ) VALUES (?, ?, ?, ?, ?, 'pending')`
      )
      for (const track of input.tracks) {
        insert.run(sessionId, track.number, track.title, track.artist, assertRelPath(track.relPath))
      }
      return sessionId
    })()
  }

  load(sessionId: number): RipSessionRecord {
    const row = this.db
      .prepare(
        `SELECT id, disc_id AS discId, toc_hash AS tocHash, release_mbid AS releaseMbid,
                root_id AS rootId, rel_dir AS relDir, template, album,
                album_artist AS albumArtist, year, verify, state,
                created_at AS createdAt, updated_at AS updatedAt
           FROM rip_sessions WHERE id = ?`
      )
      .get(sessionId) as
      (Omit<RipSessionRecord, 'tracks' | 'verify'> & { verify: number }) | undefined
    if (!row) throw new OscineError('not-found', 'That rip session no longer exists.')
    const tracks = this.db
      .prepare(
        `SELECT session_id AS sessionId, track_number AS trackNumber, title, artist,
                rel_path AS relPath, status, sha256, attempts,
                error_code AS errorCode
           FROM rip_session_tracks
          WHERE session_id = ?
          ORDER BY track_number`
      )
      .all(sessionId) as RipSessionTrackRecord[]
    const cover = this.db
      .prepare('SELECT artwork_bytes AS bytes, artwork_mime AS mime FROM rip_sessions WHERE id = ?')
      .get(sessionId) as { bytes: Uint8Array | null; mime: string | null }
    return {
      ...row,
      verify: row.verify === 1,
      tracks,
      artwork: cover.bytes && cover.mime ? { bytes: cover.bytes, mime: cover.mime } : null
    }
  }

  /** Most recently updated `running` session, if any. */
  unfinished(): RipResumeOffer | null {
    const row = this.db
      .prepare(
        `SELECT s.id AS sessionId, s.disc_id AS discId, s.toc_hash AS tocHash,
                s.album AS album, s.album_artist AS albumArtist,
                count(t.track_number) AS total,
                coalesce(sum(t.status IN ('pending', 'failed')), 0) AS remaining,
                coalesce(sum(t.status = 'written'), 0) AS written
           FROM rip_sessions s
           JOIN rip_session_tracks t ON t.session_id = s.id
          WHERE s.state = 'running'
          GROUP BY s.id
          ORDER BY s.updated_at DESC, s.id DESC
          LIMIT 1`
      )
      .get() as RipResumeOffer | undefined
    return row ?? null
  }

  /**
   * Starting over on the same disc: the previous `running` session is cancelled
   * so it is not offered beside the new one.
   */
  cancelRunningWithTocHash(tocHash: string): void {
    this.db
      .prepare(
        `UPDATE rip_sessions
            SET state = 'cancelled', updated_at = ?
          WHERE state = 'running' AND toc_hash = ?`
      )
      .run(this.now(), tocHash)
  }

  setState(sessionId: number, state: RipSessionState): void {
    const changed = this.db
      .prepare('UPDATE rip_sessions SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, this.now(), sessionId).changes
    if (changed === 0) throw new OscineError('not-found', 'That rip session no longer exists.')
  }

  dismiss(sessionId: number): void {
    const row = this.db.prepare('SELECT state FROM rip_sessions WHERE id = ?').get(sessionId) as
      { state: RipSessionState } | undefined
    if (!row) return
    if (row.state !== 'running') return
    this.setState(sessionId, 'cancelled')
  }

  /** Increment attempts; status stays `pending` until {@link recordOutcome}. */
  beginTrack(sessionId: number, trackNumber: number): void {
    const changed = this.db
      .prepare(
        `UPDATE rip_session_tracks
            SET attempts = attempts + 1
          WHERE session_id = ? AND track_number = ?`
      )
      .run(sessionId, trackNumber).changes
    if (changed === 0)
      throw new OscineError('not-found', 'That rip session track no longer exists.')
    this.touch(sessionId)
  }

  recordOutcome(sessionId: number, outcome: RipOutcome, sha256?: string | null): void {
    const relPath = outcome.relPath !== undefined ? assertRelPath(outcome.relPath) : undefined
    const changed = this.db
      .prepare(
        `UPDATE rip_session_tracks
            SET status = ?,
                rel_path = coalesce(?, rel_path),
                sha256 = ?,
                error_code = ?
          WHERE session_id = ? AND track_number = ?`
      )
      .run(
        outcome.status,
        relPath ?? null,
        sha256 ?? null,
        outcome.code ?? null,
        sessionId,
        outcome.trackNumber
      ).changes
    if (changed === 0)
      throw new OscineError('not-found', 'That rip session track no longer exists.')
    this.touch(sessionId)
  }

  private touch(sessionId: number): void {
    this.db
      .prepare('UPDATE rip_sessions SET updated_at = ? WHERE id = ?')
      .run(this.now(), sessionId)
  }
}

function assertRelPath(relPath: string): string {
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.includes(WIN_SEP)) {
    throw new OscineError('invalid-request', 'Rip session paths must be root-relative and POSIX.')
  }
  return relPath
}
