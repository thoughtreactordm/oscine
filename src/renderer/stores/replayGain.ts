import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { library } from '@renderer/ipc'
import {
  jobIsActive,
  measureVerb,
  nudgeFor,
  type MeasureOutcome,
  type Nudge
} from '@renderer/replaygain/measureModel'
import { useSettings } from '@renderer/settings'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING } from '@shared/settings'
import type { ReplayGainJobProgress, ReplayGainSummary } from '@shared/library'

/**
 * How often the library-wide counts are re-read while a job is running.
 *
 * Progress already arrives throttled from main (`jobService.ts`); this is a
 * second, slower floor for the summary, which is a `tracks` aggregate rather
 * than a job-row one. The progress bar moves at the event rate; the three
 * counts beside it do not need to.
 */
const SUMMARY_REFRESH_MS = 1_000

/**
 * W25-1: the ReplayGain measurement, as the renderer sees it.
 *
 * One store so the settings block, the palette command and the post-scan nudge
 * agree on what is running. The frame starts it (like `libraryRoots`), because
 * a job started from the palette still has to report while Settings is closed.
 */
export const useReplayGainStore = defineStore('replayGain', () => {
  const settings = useSettings()
  const roots = useLibraryRootsStore()

  const summary = ref<ReplayGainSummary | null>(null)
  const job = ref<ReplayGainJobProgress | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)
  /** What the last nudge this session announced. See `nudgeFor`. */
  let lastNudgedMissing: number | null = null

  const computeAllowed = computed(
    () => settings.get(AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING.key) !== false
  )
  const active = computed(() => jobIsActive(job.value))

  let stopProgress: (() => void) | null = null
  let summaryTimer: ReturnType<typeof setTimeout> | null = null
  let summaryDueAt = 0

  async function refreshSummary(): Promise<void> {
    try {
      summary.value = await library.getReplayGainSummary()
    } catch (cause) {
      error.value = (cause as Error).message
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [nextSummary, nextJob] = await Promise.all([
        library.getReplayGainSummary(),
        library.getReplayGainJob()
      ])
      summary.value = nextSummary
      job.value = nextJob
    } catch (cause) {
      error.value = (cause as Error).message
    }
  }

  /** Coalesced re-read of the counts; immediate when a job has just finished. */
  function scheduleSummary(immediate: boolean): void {
    if (immediate) {
      if (summaryTimer) clearTimeout(summaryTimer)
      summaryTimer = null
      void refreshSummary()
      return
    }
    if (summaryTimer) return
    const wait = Math.max(0, summaryDueAt - Date.now())
    summaryTimer = setTimeout(() => {
      summaryTimer = null
      summaryDueAt = Date.now() + SUMMARY_REFRESH_MS
      void refreshSummary()
    }, wait)
  }

  function accept(progress: ReplayGainJobProgress): void {
    // A response and an event can cross; never let an older job overwrite a newer one.
    if (job.value && progress.jobId < job.value.jobId) return
    job.value = progress
  }

  async function run(
    request: () => Promise<ReplayGainJobProgress>
  ): Promise<ReplayGainJobProgress> {
    busy.value = true
    error.value = null
    try {
      const progress = await request()
      accept(progress)
      scheduleSummary(progress.done)
      return progress
    } catch (cause) {
      error.value = (cause as Error).message
      throw cause
    } finally {
      busy.value = false
    }
  }

  function startJob(): Promise<ReplayGainJobProgress> {
    return run(() => library.startReplayGain())
  }

  function resumeJob(): Promise<ReplayGainJobProgress> {
    const current = job.value
    if (!current) return Promise.reject(new Error('There is no ReplayGain job to resume.'))
    return run(() => library.resumeReplayGain(current.jobId))
  }

  function cancelJob(): Promise<ReplayGainJobProgress> {
    const current = job.value
    if (!current) return Promise.reject(new Error('There is no ReplayGain job to cancel.'))
    return run(() => library.cancelReplayGain(current.jobId))
  }

  /**
   * "Measure", from the palette or the nudge: resume what exists, otherwise
   * start. Rejects with main's own message when the gate refuses.
   */
  async function measure(): Promise<MeasureOutcome> {
    // The latest job may have changed in another surface since the last event.
    if (!job.value) await refresh()
    const verb = measureVerb(job.value)
    if (verb === 'running') return { kind: 'running' }
    if (verb === 'resume') {
      const progress = await resumeJob()
      return { kind: 'resumed', pending: progress.pending }
    }
    const progress = await startJob()
    return progress.total === 0 ? { kind: 'nothing' } : { kind: 'started', total: progress.total }
  }

  /**
   * Called once a scan has settled. Re-reads the counts and answers whether
   * the session should be told; recording the answer is part of asking, so a
   * second caller for the same scan gets `null`.
   */
  async function nudgeAfterScan(): Promise<Nudge | null> {
    await refresh()
    if (!summary.value) return null
    const nudge = nudgeFor({
      summary: summary.value,
      job: job.value,
      computeAllowed: computeAllowed.value,
      lastNudgedMissing
    })
    if (nudge) lastNudgedMissing = nudge.missing
    return nudge
  }

  function start(): void {
    if (stopProgress) return
    stopProgress = library.onReplayGainProgress((progress) => {
      accept(progress)
      scheduleSummary(progress.done || progress.state === 'paused')
    })
    void refresh()
  }

  function stop(): void {
    stopProgress?.()
    stopProgress = null
    if (summaryTimer) clearTimeout(summaryTimer)
    summaryTimer = null
  }

  // A finished scan changes the buckets (new untagged rows, tags found on
  // rescan). The nudge is the frame's; the counts are refreshed for everyone.
  watch(
    () => roots.version,
    () => scheduleSummary(false)
  )

  return {
    summary,
    job,
    busy,
    error,
    computeAllowed,
    active,
    refresh,
    startJob,
    resumeJob,
    cancelJob,
    measure,
    nudgeAfterScan,
    start,
    stop
  }
})
