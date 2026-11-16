import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import type {
  ReplayGainJobProgress,
  ReplayGainStartRequest,
  ReplayGainSummary
} from '@shared/library'
import { WorkerReplayGainAnalyzer, type ReplayGainAnalyzer } from './analyzer'
import { ReplayGainJobStore, type ReplayGainWorkItem } from './jobStore'

const WORKER_COUNT = 2

/**
 * The floor between two per-track progress events.
 *
 * Load-bearing, not cosmetic. Every event is a `PROGRESS_SQL` aggregate over
 * the job's items and an IPC message the renderer has to parse and render; at
 * two workers on short tracks that is a stream fast enough to starve the
 * renderer's event loop — the failure that once left a Cancel button unable to
 * answer a click. State transitions are never throttled: they are what a
 * control is waiting on.
 */
const PROGRESS_INTERVAL_MS = 250

export interface ReplayGainJobDeps {
  db: Database.Database
  onProgress: (progress: ReplayGainJobProgress) => void
  createAnalyzer?: () => ReplayGainAnalyzer
  /**
   * `audio.replayGainComputeWhenMissing`, read at the moment it is needed.
   *
   * A predicate rather than a boolean because the setting can be turned off
   * while a job is queued, and a value captured at construction would be one
   * this service never heard change. Read in `start` and `resume` only: a job
   * already running is not killed mid-track, because the work it is part-way
   * through is the expensive part and the store checkpoints per track.
   *
   * Omitting it means always allowed, which is what every test and every caller
   * without a settings service wants.
   */
  canCompute?: () => boolean
  /**
   * Staged ReplayGain rows a new measurement dropped (Decision F), so the
   * renderer's review and editor can re-read them. Called after the delete has
   * committed; omitted means nobody is listening.
   */
  onStagedCleared?: (trackIds: number[]) => void
  /** Injectable so tests can drive the progress throttle deterministically. */
  progressIntervalMs?: number
  now?: () => number
}

export class ReplayGainJobService {
  private readonly store: ReplayGainJobStore
  private readonly createAnalyzer: () => ReplayGainAnalyzer
  private running: Promise<void> | null = null
  private abort: AbortController | null = null
  private closing = false
  /** The title most recently claimed by a worker, carried by throttled events. */
  private currentTitle: string | null = null
  private readonly progressIntervalMs: number
  private readonly now: () => number
  private lastEmitAt = Number.NEGATIVE_INFINITY
  private trailing: { timer: ReturnType<typeof setTimeout>; jobId: number } | null = null

  constructor(private readonly deps: ReplayGainJobDeps) {
    this.store = new ReplayGainJobStore(deps.db)
    this.store.recoverInterrupted()
    this.createAnalyzer = deps.createAnalyzer ?? (() => new WorkerReplayGainAnalyzer())
    this.progressIntervalMs = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS
    this.now = deps.now ?? Date.now
  }

  async start(request: ReplayGainStartRequest = {}): Promise<ReplayGainJobProgress> {
    this.assertComputeAllowed()
    const progress = this.store.createJob(request)
    if (progress.total === 0) {
      this.store.setState(progress.jobId, 'completed')
      return this.emit(progress.jobId)
    }
    this.launch(progress.jobId)
    return this.emit(progress.jobId)
  }

  async get(): Promise<ReplayGainJobProgress | null> {
    return this.store.latestProgress()
  }

  async summary(): Promise<ReplayGainSummary> {
    return this.store.summary()
  }

  async cancel(jobId: number): Promise<ReplayGainJobProgress> {
    const state = this.store.state(jobId)
    if (state === 'completed' || state === 'cancelled') return this.store.progress(jobId)
    if (state === 'paused') {
      this.store.setState(jobId, 'cancelled')
      return this.emit(jobId)
    }
    this.store.setState(jobId, 'cancelling')
    this.emit(jobId)
    this.abort?.abort()
    await this.running
    return this.store.progress(jobId)
  }

  async resume(jobId: number): Promise<ReplayGainJobProgress> {
    this.assertComputeAllowed()
    const state = this.store.state(jobId)
    if (state !== 'paused' && state !== 'cancelled') {
      throw new OscineError('conflict', 'Only a paused or canceled ReplayGain job can resume.')
    }
    this.store.setState(jobId, 'running')
    this.launch(jobId)
    return this.emit(jobId)
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.clearTrailing()
    const progress = this.store.latestProgress()
    if (progress && (progress.state === 'running' || progress.state === 'cancelling')) {
      this.store.pause(progress.jobId)
    }
    this.abort?.abort()
    await this.running
  }

  /**
   * The gate, stated as a refusal rather than as a silent no-op.
   *
   * A `start` that returned an empty completed job would be indistinguishable
   * from a library that is already fully analysed, and the operator would be
   * left looking for tracks the job had never been allowed to touch.
   */
  private assertComputeAllowed(): void {
    if (this.deps.canCompute && !this.deps.canCompute()) {
      throw new OscineError(
        'conflict',
        'Analyzing untagged tracks is turned off in audio settings.'
      )
    }
  }

  private launch(jobId: number): void {
    if (this.running) {
      throw new OscineError('conflict', 'A ReplayGain job is already running.')
    }
    const abort = new AbortController()
    this.abort = abort
    const run = this.run(jobId, abort.signal).finally(() => {
      if (this.running === run) this.running = null
      if (this.abort === abort) this.abort = null
      this.currentTitle = null
    })
    this.running = run
    void run.catch((error: unknown) => {
      console.error(`[replaygain] job ${jobId} failed:`, error)
      if (!this.closing) {
        this.store.pause(jobId)
        this.emit(jobId)
      }
    })
  }

  private async run(jobId: number, signal: AbortSignal): Promise<void> {
    const analyzers = Array.from({ length: WORKER_COUNT }, () => this.createAnalyzer())
    try {
      await Promise.all(analyzers.map((analyzer) => this.workerLoop(jobId, analyzer, signal)))

      if (this.closing) return
      if (signal.aborted || this.store.state(jobId) === 'cancelling') {
        this.store.setState(jobId, 'cancelled')
      } else {
        this.notifyCleared(this.store.finalizeAlbums(jobId))
        this.store.setState(jobId, 'completed')
      }
      this.currentTitle = null
      this.emit(jobId)
    } finally {
      await Promise.all(analyzers.map((analyzer) => analyzer.close()))
    }
  }

  private async workerLoop(
    jobId: number,
    analyzer: ReplayGainAnalyzer,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      const item = this.store.claimNext(jobId)
      if (!item) return
      this.currentTitle = item.title
      this.emitThrottled(jobId)
      await this.analyzeItem(analyzer, item, signal)
      if (!this.closing) this.emitThrottled(jobId)
    }
  }

  private async analyzeItem(
    analyzer: ReplayGainAnalyzer,
    item: ReplayGainWorkItem,
    signal: AbortSignal
  ): Promise<void> {
    if (!item.path) {
      this.store.fail(item, 'The library path is invalid.')
      return
    }
    try {
      const result = await analyzer.analyze(item.path, signal)
      // A finished unit is checkpointed even when cancellation arrived during
      // its final DSP instruction. This is the track-sized durability promise.
      if (this.store.complete(item, result)) this.notifyCleared([item.trackId])
    } catch (error) {
      if (signal.aborted) {
        if (!this.closing) this.store.returnToPending(item)
        return
      }
      console.warn(`[replaygain] track ${item.trackId} failed:`, error)
      this.store.fail(item, 'The file could not be decoded or analyzed.')
    }
  }

  /**
   * Emit now. Every state transition comes through here, and it supersedes
   * any per-track event still waiting, so a stale `running` can never land
   * after the `cancelled` that replaced it.
   */
  private emit(jobId: number): ReplayGainJobProgress {
    this.clearTrailing()
    const progress = this.store.progress(jobId, this.titleFor(jobId))
    this.lastEmitAt = this.now()
    this.deps.onProgress(progress)
    return progress
  }

  /**
   * A per-track event, coalesced to {@link progressIntervalMs}. Leading and
   * trailing: the first event in a quiet window goes at once, the rest collapse
   * into one that fires when the window closes, so the final count of a burst
   * is never the one that is dropped.
   */
  private emitThrottled(jobId: number): void {
    const elapsed = this.now() - this.lastEmitAt
    if (elapsed >= this.progressIntervalMs) {
      this.emit(jobId)
      return
    }
    if (this.trailing) return
    const timer = setTimeout(() => {
      this.trailing = null
      if (!this.closing) this.emit(jobId)
    }, this.progressIntervalMs - elapsed)
    timer.unref?.()
    this.trailing = { timer, jobId }
  }

  private clearTrailing(): void {
    if (!this.trailing) return
    clearTimeout(this.trailing.timer)
    this.trailing = null
  }

  private notifyCleared(trackIds: number[]): void {
    if (trackIds.length > 0) this.deps.onStagedCleared?.(trackIds)
  }

  /** Only a job that is working on something has a current track to name. */
  private titleFor(jobId: number): string | null {
    const state = this.store.state(jobId)
    return state === 'running' || state === 'cancelling' ? this.currentTitle : null
  }
}
