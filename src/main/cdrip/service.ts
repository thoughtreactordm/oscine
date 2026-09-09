import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { Readable } from 'node:stream'
import { File as TagFile } from 'node-taglib-sharp'
import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import { renderRipPath } from '@shared/ripPath'
import type {
  CdDriveInfo,
  CdToc,
  DiscLookupResult,
  RipFailureCode,
  RipOutcome,
  RipPhase,
  RipProgress,
  RipReport,
  RipRequest
} from '@shared/cdrip'
import { toAbsPath } from '../db/paths'
import {
  ARTWORK_UNCHANGED,
  applyWritableTags,
  type WritableTags
} from '../library/writeback/writer'
import { CdDriveError, type CdDrive } from './drive'
import type { DiscLookup } from './discLookup'
import { EncoderError, type Encoder } from './encoder'
import { commitRipPart, placeRipDest, removeQuietly, type RipDestResolver } from './ingest'

/**
 * The rip orchestrator — **W18-5**. Drive → sectors → encoder → tags → temp
 * file, one track at a time, modelled on {@link TagWritebackService}: injectable
 * deps, coalesced progress, a token cancel checked between chunks.
 *
 * The `.part` sibling is same-directory so W18-6's rename stays same-device.
 * After the last rename, {@link RipIngest} indexes the files explicitly —
 * the watcher may be off, and a silent miss there is a bug nobody can reproduce.
 */

/** Addon cap: `readSectors` rejects a count outside 1..450. */
const MAX_SECTOR_CHUNK = 450

/** The default gap between coalesced progress events — a comfortable ~20/sec ceiling. */
const PROGRESS_THROTTLE_MS = 50

export type RipPathResolver = RipDestResolver

export type ApplyRipTags = (absPath: string, tags: WritableTags) => Promise<void>

/**
 * Index the files this rip just renamed into a root. Returns their library
 * ids, in the order the abs paths were given.
 *
 * Production wires the library service; tests omit it and `trackIds` stay empty.
 */
export type RipIngest = (rootId: number, absPaths: readonly string[]) => Promise<readonly number[]>

export interface RipServiceDeps {
  readonly drive: CdDrive
  readonly lookup: DiscLookup
  readonly encoder: Encoder
  readonly resolvePath: RipPathResolver
  /** Clock for progress throttling. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Minimum gap between progress emissions, in ms. Defaults to 50. */
  readonly throttleMs?: number
  /**
   * Sectors per `readSectors` call, capped at the addon's 450. Tests drop this
   * to 1 so cancel-between-chunks is observable without a 450-sector wait.
   */
  readonly readChunkSectors?: number
  /** Defaults to taglib on a hidden `.flac` sibling of the `.part` file. */
  readonly applyTags?: ApplyRipTags
  /** After the last rename. Omitted, the files land unindexed. */
  readonly ingest?: RipIngest
}

/**
 * Builds a `rootId + relPath → absolute dest` resolver over a database.
 *
 * Same `toAbsPath` rejoin as every other library path, so a rip cannot be the
 * one code path that stores an absolute path in `tracks` once W18-6 indexes it.
 */
export function ripDestResolver(db: Database.Database): RipPathResolver {
  const statement = db.prepare(`SELECT path FROM roots WHERE id = ?`)
  return (rootId, relPath) => {
    const row = statement.get(rootId) as { path: string } | undefined
    return row ? toAbsPath(row.path, relPath) : null
  }
}

export class RipService {
  private readonly drive: CdDrive
  private readonly lookup: DiscLookup
  private readonly encoder: Encoder
  private readonly resolvePath: RipPathResolver
  private readonly now: () => number
  private readonly throttleMs: number
  private readonly chunkSectors: number
  private readonly applyTags: ApplyRipTags
  private readonly ingest: RipIngest | undefined

  /** Set for the lifetime of one rip; its `aborted` flag is what cancel flips. */
  private inFlight: { aborted: boolean } | null = null

  constructor(deps: RipServiceDeps) {
    this.drive = deps.drive
    this.lookup = deps.lookup
    this.encoder = deps.encoder
    this.resolvePath = deps.resolvePath
    this.now = deps.now ?? Date.now
    this.throttleMs = deps.throttleMs ?? PROGRESS_THROTTLE_MS
    const chunk = deps.readChunkSectors ?? MAX_SECTOR_CHUNK
    this.chunkSectors = Math.min(MAX_SECTOR_CHUNK, Math.max(1, Math.trunc(chunk)))
    this.applyTags = deps.applyTags ?? applyRipTags
    this.ingest = deps.ingest
  }

  listDrives(): Promise<CdDriveInfo[]> {
    return this.withDrive(() => this.drive.listDrives())
  }

  readToc(driveId: string): Promise<CdToc> {
    return this.withDrive(() => this.drive.readToc(driveId))
  }

  /** W18-6's metadata match sits on the same service so tests inject one lookup. */
  lookupDisc(toc: CdToc): Promise<DiscLookupResult> {
    return this.lookup.lookup(toc)
  }

  /**
   * Rips the confirmed selection, sequential and cooperative.
   *
   * Data tracks are dropped here — the TOC carried them so the disc ID would
   * be right; nothing below this point should ever see one. One track's failure
   * is reported and the batch continues. Progress is coalesced to
   * {@link throttleMs} so a per-sector stream cannot flood the renderer.
   */
  async start(
    request: RipRequest,
    onProgress: (progress: RipProgress) => void
  ): Promise<RipReport> {
    if (this.inFlight !== null) {
      throw new OscineError('conflict', 'A CD rip is already running.')
    }
    const token = { aborted: false }
    this.inFlight = token

    let toc: CdToc
    try {
      toc = await this.drive.readToc(request.driveId)
    } catch (error) {
      this.inFlight = null
      throw toOscineDriveError(error)
    }

    const ranges = trackRanges(toc)
    const jobs = request.tracks.filter((track) => {
      const range = ranges.get(track.number)
      return range !== undefined && range.isAudio
    })

    const total = jobs.length
    const outcomes: RipOutcome[] = []
    const rippedAbs: string[] = []
    let written = 0
    let skipped = 0
    let failed = 0
    let lastEmit = 0

    const emit = (progress: RipProgress, force: boolean): void => {
      const now = this.now()
      if (!force && now - lastEmit < this.throttleMs) return
      lastEmit = now
      onProgress(progress)
    }

    try {
      for (let trackIndex = 0; trackIndex < jobs.length; trackIndex++) {
        if (token.aborted) break
        const selection = jobs[trackIndex]!
        const range = ranges.get(selection.number)!
        const outcome = await this.ripOne(request, selection, range, token, (phase, done) => {
          emit(
            {
              trackNumber: selection.number,
              trackIndex,
              trackCount: total,
              phase,
              sectorsDone: done,
              sectorsTotal: range.count
            },
            false
          )
        })
        if (token.aborted && outcome === null) break
        if (outcome === null) continue
        outcomes.push(outcome)
        if (outcome.status === 'written') written += 1
        else if (outcome.status === 'skipped') skipped += 1
        else failed += 1
        if (
          (outcome.status === 'written' || outcome.status === 'verify-failed') &&
          outcome.relPath !== undefined
        ) {
          const abs = this.resolvePath(request.rootId, outcome.relPath)
          if (abs !== null) rippedAbs.push(abs)
        }
        emit(
          {
            trackNumber: selection.number,
            trackIndex,
            trackCount: total,
            phase: 'tagging',
            sectorsDone: range.count,
            sectorsTotal: range.count
          },
          true
        )
      }
    } finally {
      this.inFlight = null
    }

    let trackIds: number[] = []
    if (this.ingest && rippedAbs.length > 0) {
      try {
        trackIds = [...(await this.ingest(request.rootId, rippedAbs))]
      } catch (error) {
        console.warn('[cdrip] ingest failed:', error)
      }
    }

    return { total, written, skipped, failed, cancelled: token.aborted, outcomes, trackIds }
  }

  /** Stops the running rip between chunks. A no-op when nothing is running. */
  cancel(): void {
    if (this.inFlight !== null) this.inFlight.aborted = true
  }

  private async ripOne(
    request: RipRequest,
    selection: RipRequest['tracks'][number],
    range: TrackRange,
    token: { aborted: boolean },
    onPhase: (phase: RipPhase, sectorsDone: number) => void
  ): Promise<RipOutcome | null> {
    const relPath = ripRelPath(request, selection, this.encoder.ext)
    const destAbs = this.resolvePath(request.rootId, relPath)
    if (destAbs === null) {
      console.warn(`[cdrip] track ${selection.number} destination did not resolve inside a root`)
      return { trackNumber: selection.number, status: 'failed', code: 'destination-failed' }
    }

    let finalRel: string
    let finalAbs: string
    try {
      const placed = await placeRipDest({
        onCollision: request.onCollision,
        rootId: request.rootId,
        relPath,
        absPath: destAbs,
        resolvePath: this.resolvePath
      })
      if (placed === 'skip') {
        return { trackNumber: selection.number, status: 'skipped', relPath }
      }
      finalRel = placed.relPath
      finalAbs = placed.absPath
    } catch (error) {
      console.warn(`[cdrip] track ${selection.number} destination failed:`, error)
      return { trackNumber: selection.number, status: 'failed', code: 'destination-failed' }
    }

    const partPath = `${finalAbs}.${randomBytes(6).toString('hex')}.part`
    try {
      await mkdir(dirname(partPath), { recursive: true })
    } catch (error) {
      console.warn(`[cdrip] track ${selection.number} could not create destination:`, error)
      return { trackNumber: selection.number, status: 'failed', code: 'destination-failed' }
    }

    const firstHash = createHash('sha256')
    const readFail: { error?: unknown } = {}
    onPhase('reading', 0)
    const pcm = Readable.from(
      this.readPcm(request.driveId, range, token, firstHash, readFail, (done) =>
        onPhase('reading', done)
      )
    )

    try {
      await this.encoder.encode(pcm, partPath, token)
    } catch (error) {
      await removeQuietly(partPath)
      if (token.aborted || isCancelled(error)) return null
      if (readFail.error) return driveFailure(selection.number, readFail.error)
      return encoderFailure(selection.number, error)
    }

    if (token.aborted) {
      await removeQuietly(partPath)
      return null
    }
    if (readFail.error) {
      await removeQuietly(partPath)
      return driveFailure(selection.number, readFail.error)
    }

    onPhase('encoding', range.count)
    onPhase('tagging', range.count)
    try {
      await this.applyTags(partPath, {
        title: selection.title.trim() === '' ? null : selection.title,
        artist: (selection.artist.trim() || request.albumArtist).trim() || null,
        album: request.album.trim() === '' ? null : request.album,
        trackNo: selection.number,
        discNo: 1,
        year: request.year,
        genres: [],
        artwork: ARTWORK_UNCHANGED
      })
    } catch (error) {
      await removeQuietly(partPath)
      console.warn(`[cdrip] track ${selection.number} tagging failed:`, error)
      return { trackNumber: selection.number, status: 'failed', code: 'tag-failed' }
    }

    if (token.aborted) {
      await removeQuietly(partPath)
      return null
    }

    let verifyFailed = false
    if (request.verify) {
      onPhase('verifying', 0)
      const secondHash = createHash('sha256')
      const verifyFail: { error?: unknown } = {}
      for await (const chunk of this.readPcm(
        request.driveId,
        range,
        token,
        secondHash,
        verifyFail,
        (done) => onPhase('verifying', done)
      )) {
        void chunk
      }
      if (token.aborted) {
        await removeQuietly(partPath)
        return null
      }
      if (verifyFail.error) {
        await removeQuietly(partPath)
        return driveFailure(selection.number, verifyFail.error)
      }
      if (firstHash.digest('hex') !== secondHash.digest('hex')) {
        verifyFailed = true
        console.warn(
          `[cdrip] track ${selection.number} verify mismatch over sectors ` +
            `${range.start}..${range.start + range.count - 1}`
        )
      }
    }

    try {
      await commitRipPart(partPath, finalAbs, request.onCollision === 'overwrite')
    } catch (error) {
      await removeQuietly(partPath)
      console.warn(`[cdrip] track ${selection.number} rename failed:`, error)
      return { trackNumber: selection.number, status: 'failed', code: 'destination-failed' }
    }

    if (verifyFailed) {
      return {
        trackNumber: selection.number,
        status: 'verify-failed',
        relPath: finalRel,
        startSector: range.start,
        sectorCount: range.count
      }
    }
    return { trackNumber: selection.number, status: 'written', relPath: finalRel }
  }

  private async *readPcm(
    driveId: string,
    range: TrackRange,
    token: { aborted: boolean },
    hash: { update(data: Buffer): unknown },
    fail: { error?: unknown },
    onSectors: (sectorsDone: number) => void
  ): AsyncGenerator<Buffer> {
    let offset = 0
    try {
      while (offset < range.count) {
        if (token.aborted) return
        const n = Math.min(this.chunkSectors, range.count - offset)
        const { pcm } = await this.drive.readSectors(driveId, range.start + offset, n)
        if (token.aborted) return
        hash.update(pcm)
        offset += n
        onSectors(offset)
        yield pcm
      }
    } catch (error) {
      fail.error = error
    }
  }

  private async withDrive<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw toOscineDriveError(error)
    }
  }
}

interface TrackRange {
  start: number
  count: number
  isAudio: boolean
}

/**
 * Consecutive TOC offsets, so a pregap belongs to the track before it.
 * `sectorCount` on the entry is ignored: using the next start (or lead-out)
 * is the whole convention, and there is no special case for the gap.
 */
export function trackRanges(toc: CdToc): Map<number, TrackRange> {
  const out = new Map<number, TrackRange>()
  for (let i = 0; i < toc.entries.length; i++) {
    const entry = toc.entries[i]!
    const next = toc.entries[i + 1]?.startSector ?? toc.leadOutSector
    out.set(entry.number, {
      start: entry.startSector,
      count: Math.max(0, next - entry.startSector),
      isAudio: entry.isAudio
    })
  }
  return out
}

export function ripRelPath(
  request: Pick<RipRequest, 'relDir' | 'template' | 'album' | 'albumArtist' | 'year'>,
  track: RipRequest['tracks'][number],
  ext: string
): string {
  const rendered = renderRipPath(request.template, {
    albumartist: request.albumArtist,
    artist: track.artist,
    album: request.album,
    title: track.title,
    track: track.number,
    disc: 1,
    discCount: 1,
    year: request.year
  })
  const stem = posix.join(request.relDir, rendered)
  return `${stem}.${ext}`
}

async function applyRipTags(partPath: string, tags: WritableTags): Promise<void> {
  const hidden = join(dirname(partPath), `.oscine-rip-${randomBytes(6).toString('hex')}.flac`)
  await rename(partPath, hidden)
  try {
    const file = TagFile.createFromPath(hidden)
    try {
      applyWritableTags(file, tags)
      file.save()
    } finally {
      file.dispose()
    }
    await rename(hidden, partPath)
  } catch (error) {
    try {
      await rename(hidden, partPath)
    } catch {
      await removeQuietly(hidden)
    }
    throw error
  }
}

function driveFailure(trackNumber: number, error: unknown): RipOutcome {
  const code: RipFailureCode = error instanceof CdDriveError ? error.code : 'read-failed'
  console.warn(`[cdrip] track ${trackNumber} read failed (${code}):`, error)
  return { trackNumber, status: 'failed', code }
}

function encoderFailure(trackNumber: number, error: unknown): RipOutcome {
  const code: RipFailureCode =
    error instanceof EncoderError && error.code !== 'cancelled' ? error.code : 'nonzero-exit'
  console.warn(`[cdrip] track ${trackNumber} encode failed (${code}):`, error)
  return { trackNumber, status: 'failed', code }
}

function isCancelled(error: unknown): boolean {
  return error instanceof EncoderError && error.code === 'cancelled'
}

function toOscineDriveError(error: unknown): OscineError {
  const code = error instanceof CdDriveError ? error.code : 'read-failed'
  if (code === 'no-disc') return new OscineError('not-found', 'No disc in the drive.')
  if (code === 'device-busy') return new OscineError('conflict', 'The drive is busy.')
  if (code === 'unsupported-drive') {
    return new OscineError('io-error', 'That optical drive is not supported.')
  }
  if (code === 'not-audio') return new OscineError('io-error', 'That track is not audio.')
  return new OscineError('io-error', 'The disc could not be read.')
}
