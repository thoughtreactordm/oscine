import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import type {
  PendingWrite,
  WritebackField,
  WritebackOutcome,
  WritebackProgress,
  WritebackReport,
  WritebackSelection
} from '@shared/tagWriteback'
import { toAbsPath } from '../../db/paths'
import type { GenreCanonicalizer } from './diff'
import { writeTags, type WriteOutcome } from './engine'
import {
  selectionChangesFile,
  writableTagsFromSelection,
  type ArtworkWriteIntent,
  type WritableTags
} from './writer'

/**
 * The staged review's main-process orchestrator — **W16-6**, design authority
 * D28 → "Staged review UI". Sits between the renderer's review surface and the
 * two halves of the engine below it: the differ that mints a {@link PendingWrite}
 * (W16-1) and the atomic writer that flushes one (W16-2/W16-4).
 *
 * ## Preview reads fresh; apply re-derives fresh
 *
 * Both entry points read each file live rather than trusting the cached `tracks`
 * row — that is R7. Preview does it to show a true before/after; apply does it
 * *again*, so the bytes it writes are computed against the file as it stands at
 * flush time, not as it stood when the operator opened the review. A field
 * another tool changed out-of-band in between is reconciled, never clobbered.
 *
 * The renderer never sends tag *values* back — only which fields it approved, by
 * key. Main is the sole authority on what a file ends up holding: it re-derives
 * the diff, takes `proposed` for the selected fields and the file's own fresh
 * `current` for the rest, and writes the union. A compromised renderer can
 * choose *which* corrections to flush but cannot fabricate one.
 *
 * ## Never leak a path
 *
 * The engine's {@link WriteOutcome} carries the absolute path and a raw error
 * reason; the renderer sees neither, by standing invariant. Every failure is
 * mapped to a {@link WritebackOutcome} of `{ trackId, code }` and the detail is
 * logged here, in main.
 */

/** The differ seam the service flushes through — {@link TagWritebackDiffer}'s shape. */
export interface PendingWriteSource {
  pendingWrite(trackId: number, canonicalize?: GenreCanonicalizer): Promise<PendingWrite | null>
}

/** The atomic write seam, defaulting to the real {@link writeTags}. */
export type WriteFn = (absPath: string, desired: WritableTags) => Promise<WriteOutcome>

/** Everything the service orchestrates over — all of it injectable for tests. */
export interface TagWritebackServiceDeps {
  /** Mints one track's pending write from a fresh file read (R7). */
  readonly differ: PendingWriteSource
  /** Resolves a track id to its absolute path, or `null` if it no longer resolves. */
  readonly resolvePath: (trackId: number) => string | null
  /** The atomic tag write. Defaults to {@link writeTags}. */
  readonly write?: WriteFn
  /** All tracks with an unwritten correction — the pending set. Defaults to none. */
  readonly pendingTrackIds?: () => readonly number[] | Promise<readonly number[]>
  /** Retires a track's just-flushed override columns. Defaults to a no-op. */
  readonly retire?: (trackId: number, fields: readonly WritebackField[]) => void | Promise<void>
  /** Genre canonicalization (W16-5), applied identically to preview and apply. */
  readonly canonicalize?: GenreCanonicalizer
  /**
   * Artwork intent, resolved fresh from the W16-9 override store at apply time
   * (R7). Absent and every flush is `unchanged` for pictures — the engine
   * default, and what a test that is not exercising artwork wants. W16-12 will
   * gate this on the selected `artwork` field; until then a flush of a track
   * with an override writes the cover alongside the selected text fields.
   */
  readonly resolveArtwork?: (trackId: number) => Promise<ArtworkWriteIntent>
  /** Clock for progress throttling. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Minimum gap between progress emissions, in ms. Defaults to 50. */
  readonly throttleMs?: number
}

/** The default gap between coalesced progress events — a comfortable ~20/sec ceiling. */
const PROGRESS_THROTTLE_MS = 50

/**
 * Builds a `trackId -> absolute path` resolver over a database.
 *
 * The same `roots ⋈ tracks` join the differ resolves its read path through, and
 * the same {@link toAbsPath} rejoin — so the write targets exactly the file the
 * diff was computed against, and the relative-path/root invariant is honoured on
 * this read the way it is on every other.
 */
export function trackPathResolver(db: Database.Database): (trackId: number) => string | null {
  const statement = db.prepare(`
    SELECT r.path AS rootPath, t.rel_path AS relPath
    FROM tracks t
    JOIN roots r ON r.id = t.root_id
    WHERE t.id = ?
  `)
  return (trackId: number): string | null => {
    const row = statement.get(trackId) as { rootPath: string; relPath: string } | undefined
    return row ? toAbsPath(row.rootPath, row.relPath) : null
  }
}

export class TagWritebackService {
  private readonly differ: PendingWriteSource
  private readonly resolvePath: (trackId: number) => string | null
  private readonly write: WriteFn
  private readonly pendingTrackIds: () => readonly number[] | Promise<readonly number[]>
  private readonly retire: (
    trackId: number,
    fields: readonly WritebackField[]
  ) => void | Promise<void>
  private readonly canonicalize?: GenreCanonicalizer
  private readonly resolveArtwork?: (trackId: number) => Promise<ArtworkWriteIntent>
  private readonly now: () => number
  private readonly throttleMs: number

  /** Set for the lifetime of one flush; its `aborted` flag is what cancel flips. */
  private inFlight: { aborted: boolean } | null = null

  constructor(deps: TagWritebackServiceDeps) {
    this.differ = deps.differ
    this.resolvePath = deps.resolvePath
    this.write = deps.write ?? writeTags
    this.pendingTrackIds = deps.pendingTrackIds ?? (() => [])
    this.retire = deps.retire ?? (() => {})
    this.canonicalize = deps.canonicalize
    this.resolveArtwork = deps.resolveArtwork
    this.now = deps.now ?? Date.now
    this.throttleMs = deps.throttleMs ?? PROGRESS_THROTTLE_MS
  }

  /**
   * The pending writes worth reviewing across the whole library — **W16-6**.
   *
   * The write-back's default: every track with an unwritten correction, so the
   * review is the accumulated set of edits rather than a scope the operator has
   * to assemble by hand. Changed-only, like {@link preview}.
   */
  async previewPending(): Promise<PendingWrite[]> {
    return this.preview(await this.pendingTrackIds())
  }

  /**
   * The pending writes worth reviewing for a set of tracks — changed only.
   *
   * One fresh read per track. A track whose file already matches its corrections
   * is dropped (nothing to review), and one whose file cannot be read is dropped
   * too: there is no before/after to show, and if the operator flushes it anyway
   * it surfaces as a per-file failure then, not as a broken preview now.
   */
  async preview(trackIds: readonly number[]): Promise<PendingWrite[]> {
    const out: PendingWrite[] = []
    for (const trackId of trackIds) {
      let pending: PendingWrite | null
      try {
        pending = await this.differ.pendingWrite(trackId, this.canonicalize)
      } catch (error) {
        console.warn(`[writeback] preview skipped track ${trackId}:`, error)
        continue
      }
      if (pending !== null && pending.hasChanges) out.push(pending)
    }
    return out
  }

  /**
   * Flushes the reviewed batch, one file at a time, reporting each.
   *
   * Sequential and cooperative: the loop checks the cancel flag between files, so
   * a stop lands at a file boundary and never mid-write — the atomic engine below
   * always leaves a whole file, backup and all. One file's failure is reported
   * and the batch continues. Progress is coalesced to {@link throttleMs} so a
   * multi-thousand batch cannot flood the renderer.
   */
  async apply(
    selections: readonly WritebackSelection[],
    onProgress: (progress: WritebackProgress) => void
  ): Promise<WritebackReport> {
    if (this.inFlight !== null) {
      throw new OscineError('conflict', 'A tag write-back is already running.')
    }
    const token = { aborted: false }
    this.inFlight = token

    const total = selections.length
    const outcomes: WritebackOutcome[] = []
    let written = 0
    let skipped = 0
    let failed = 0
    let lastEmit = 0

    const emitProgress = (force: boolean): void => {
      const now = this.now()
      if (!force && now - lastEmit < this.throttleMs) return
      lastEmit = now
      onProgress({ done: written + skipped + failed, total, written, skipped, failed })
    }

    try {
      for (const selection of selections) {
        if (token.aborted) break
        const outcome = await this.flushOne(selection)
        outcomes.push(outcome)
        if (outcome.status === 'written') written += 1
        else if (outcome.status === 'skipped') skipped += 1
        else failed += 1
        // Written or skipped means the file now holds the selected fields, so
        // their overrides have done their job and are retired — the track leaves
        // the pending list and loses its "modified" mark. A failure keeps them.
        if (outcome.status !== 'failed') await this.retire(selection.trackId, selection.fields)
        emitProgress(false)
      }
    } finally {
      this.inFlight = null
    }

    emitProgress(true)
    return { total, written, skipped, failed, cancelled: token.aborted, outcomes }
  }

  /** Stops the running flush between files. A no-op when nothing is running. */
  cancel(): void {
    if (this.inFlight !== null) this.inFlight.aborted = true
  }

  /**
   * Flushes one track's approved fields, mapping the engine's outcome to the
   * renderer-safe one.
   *
   * Re-derives the diff fresh (R7), skips a track whose selected fields no longer
   * change the bytes, and drops every path and raw reason on the way out — the
   * report is `{ trackId, code }` and the detail is logged here.
   */
  private async flushOne(selection: WritebackSelection): Promise<WritebackOutcome> {
    const { trackId } = selection

    const absPath = this.resolvePath(trackId)
    if (absPath === null) {
      console.warn(`[writeback] track ${trackId} no longer resolves to a file`)
      return { trackId, status: 'failed', code: 'write-failed' }
    }

    let pending: PendingWrite | null
    try {
      pending = await this.differ.pendingWrite(trackId, this.canonicalize)
    } catch (error) {
      console.warn(`[writeback] track ${trackId} could not be re-read for flush:`, error)
      return { trackId, status: 'failed', code: 'write-failed' }
    }
    if (pending === null) {
      console.warn(`[writeback] track ${trackId} vanished before flush`)
      return { trackId, status: 'failed', code: 'write-failed' }
    }

    const selected = new Set(selection.fields)

    let artwork: ArtworkWriteIntent
    try {
      artwork = this.resolveArtwork ? await this.resolveArtwork(trackId) : { kind: 'unchanged' }
    } catch (error) {
      console.warn(`[writeback] track ${trackId} could not resolve artwork for flush:`, error)
      return { trackId, status: 'failed', code: 'write-failed' }
    }

    if (!selectionChangesFile(pending, selected) && artwork.kind === 'unchanged') {
      return { trackId, status: 'skipped' }
    }

    const outcome = await this.write(absPath, {
      ...writableTagsFromSelection(pending, selected),
      artwork
    })
    if (outcome.ok) return { trackId, status: 'written' }

    console.warn(`[writeback] track ${trackId} failed (${outcome.code}): ${outcome.reason}`)
    return { trackId, status: 'failed', code: outcome.code }
  }
}
