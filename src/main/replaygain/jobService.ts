import type Database from 'better-sqlite3'
import { OscineError } from '@shared/errors'
import type { ReplayGainJobProgress } from '@shared/library'
import { WorkerReplayGainAnalyzer, type ReplayGainAnalyzer } from './analyzer'
import { ReplayGainJobStore, type ReplayGainWorkItem } from './jobStore'

const WORKER_COUNT = 2

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
}

export class ReplayGainJobService {
  private readonly store: ReplayGainJobStore
  private readonly createAnalyzer: () => ReplayGainAnalyzer
  private running: Promise<void> | null = null
  private abort: AbortController | null = null
  private closing = false

  constructor(private readonly deps: ReplayGainJobDeps) {
    this.store = new ReplayGainJobStore(deps.db)
    this.store.recoverInterrupted()
    this.createAnalyzer = deps.createAnalyzer ?? (() => new WorkerReplayGainAnalyzer())
  }

  async start(): Promise<ReplayGainJobProgress> {
    this.assertComputeAllowed()
    const progress = this.store.createJob()
    if (progress.total === 0) {
      this.store.setState(progress.jobId, 'completed')
      return this.emit(progress.jobId)
    }
    this.launch(progress.jobId)
    return this.store.progress(progress.jobId)
  }

  async get(): Promise<ReplayGainJobProgress | null> {
    return this.store.latestProgress()
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
      throw new OscineError('conflict', 'Only a paused or cancelled ReplayGain job can resume.')
    }
    this.store.setState(jobId, 'running')
    this.launch(jobId)
    return this.store.progress(jobId)
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
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
        'Analysing untagged tracks is turned off in audio settings.'
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
        this.store.finalizeAlbums(jobId)
        this.store.setState(jobId, 'completed')
      }
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
      this.emit(jobId, item.title)
      await this.analyzeItem(analyzer, item, signal)
      if (!this.closing) this.emit(jobId)
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
      this.store.complete(item, result)
    } catch (error) {
      if (signal.aborted) {
        if (!this.closing) this.store.returnToPending(item)
        return
      }
      console.warn(`[replaygain] track ${item.trackId} failed:`, error)
      this.store.fail(item, 'The file could not be decoded or analysed.')
    }
  }

  private emit(jobId: number, currentTitle: string | null = null): ReplayGainJobProgress {
    const progress = this.store.progress(jobId, currentTitle)
    this.deps.onProgress(progress)
    return progress
  }
}
