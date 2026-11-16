import type { ReplayGainJobProgress, ReplayGainSummary } from '@shared/library'

/**
 * W25-1's pure half: what the Measure ReplayGain control shows, whether a
 * finished scan earns a nudge, and what a palette start says afterwards.
 *
 * No `@renderer` imports and no DOM, so the rules are tested without a window.
 * The store feeds this the two things main owns — the library-wide summary and
 * the latest job — plus the one setting that gates the job.
 *
 * D37 Decision A is the shape of all of it: measuring is something the operator
 * starts. A scan raises a nudge and nothing more, and the control states its
 * reason when it cannot run rather than silently doing nothing.
 */

const COUNT = new Intl.NumberFormat('en-US')

/** `1204` → `1,204`. Fixed to en-US so the copy and its tests agree everywhere. */
export function formatCount(n: number): string {
  return COUNT.format(n)
}

function tracks(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'track' : 'tracks'}`
}

/** Running or winding down — a job that owns the workers right now. */
export function jobIsActive(job: ReplayGainJobProgress | null): boolean {
  return job !== null && (job.state === 'running' || job.state === 'cancelling')
}

/**
 * Paused (the app quit mid-job) or cancelled. Main refuses a fresh start while
 * one of these exists, so the control offers Resume in Start's place.
 */
export function jobIsResumable(job: ReplayGainJobProgress | null): boolean {
  return job !== null && (job.state === 'paused' || job.state === 'cancelled')
}

/** Said wherever the gate stops the job, so every surface gives the same reason. */
export const COMPUTE_OFF_REASON =
  '“Analyze untagged tracks” is off, so measuring is refused. Turn it on to measure.'

export interface MeasureInput {
  /** `null` until the first `getReplayGainSummary` lands. */
  summary: ReplayGainSummary | null
  job: ReplayGainJobProgress | null
  /** `audio.replayGainComputeWhenMissing`. */
  computeAllowed: boolean
  /** A start, resume or cancel request is in flight. */
  busy: boolean
}

export interface MeasureButton {
  action: 'start' | 'resume'
  label: string
  disabled: boolean
}

export interface MeasureProgress {
  /** 0..1, failures included — a failed track is a track the job is done with. */
  fraction: number
  /** `312 of 1,204`. */
  label: string
  currentTitle: string | null
}

export interface MeasureView {
  /** `null` while the summary is loading. */
  counts: ReplayGainSummary | null
  /** One line under the counts — what the job is doing or last did. */
  status: string | null
  /** Start or Resume; absent while a job is active. */
  primary: MeasureButton | null
  /** Present while a job is active; disabled once a cancel is under way. */
  cancel: { label: string; disabled: boolean } | null
  progress: MeasureProgress | null
  /** Why the primary button is disabled, when the reason is not obvious from the counts. */
  reason: string | null
}

export function measureView(input: MeasureInput): MeasureView {
  const { summary, job, computeAllowed, busy } = input

  if (job && jobIsActive(job)) {
    const finished = job.completed + job.failed
    const cancelling = job.state === 'cancelling'
    return {
      counts: summary,
      status: cancelling
        ? 'Stopping after the tracks in progress…'
        : job.failed > 0
          ? `${tracks(job.failed)} could not be analyzed so far.`
          : null,
      primary: null,
      cancel: { label: cancelling ? 'Cancelling…' : 'Cancel', disabled: cancelling || busy },
      progress: {
        fraction: job.total > 0 ? Math.min(1, finished / job.total) : 0,
        label: `${formatCount(finished)} of ${formatCount(job.total)}`,
        currentTitle: cancelling ? null : job.currentTitle || null
      },
      // The gate is read at start and resume only; a running job finishes the
      // track it is on and carries on. Saying so stops "but I turned it off".
      reason: computeAllowed
        ? null
        : '“Analyze untagged tracks” was turned off after this job started. It runs to the end unless cancelled.'
    }
  }

  const reason = computeAllowed ? null : COMPUTE_OFF_REASON

  if (job && jobIsResumable(job)) {
    return {
      counts: summary,
      status:
        job.state === 'paused'
          ? `Interrupted with ${tracks(job.pending)} left.`
          : `Cancelled with ${tracks(job.pending)} left.`,
      primary: {
        action: 'resume',
        label: `Resume (${formatCount(job.pending)} left)`,
        disabled: busy || !computeAllowed
      },
      cancel: null,
      progress: null,
      reason
    }
  }

  const missing = summary?.missing ?? 0
  return {
    counts: summary,
    status: completedStatus(summary, job),
    primary: {
      action: 'start',
      label: missing > 0 ? `Measure ${tracks(missing)}` : 'Measure',
      disabled: busy || !computeAllowed || summary === null || missing === 0
    },
    cancel: null,
    progress: null,
    reason
  }
}

function completedStatus(
  summary: ReplayGainSummary | null,
  job: ReplayGainJobProgress | null
): string | null {
  if (!summary) return null
  if (summary.missing === 0) {
    return summary.tagged + summary.computed > 0 ? 'Every track has ReplayGain.' : null
  }
  if (summary.failed > 0) {
    return `${tracks(summary.failed)} could not be decoded last time. Measuring retries them.`
  }
  if (job?.state === 'completed') return 'New tracks have arrived since the last measurement.'
  return null
}

export interface NudgeInput {
  summary: ReplayGainSummary
  job: ReplayGainJobProgress | null
  computeAllowed: boolean
  /** The `missing` count the last nudge this session announced, if any. */
  lastNudgedMissing: number | null
}

export interface Nudge {
  missing: number
  message: string
}

/**
 * Whether a finished scan earns the "N tracks have no ReplayGain" toast.
 *
 * Not while a job owns the workers — the operator already said yes. Not while
 * the gate is off — a Measure button that is refused on click is a nag, not a
 * nudge. And not again for a count the session has already been told about, or
 * a smaller one: a rescan that found nothing new should stay quiet, and a
 * library that is shrinking towards measured does not need encouragement.
 */
export function nudgeFor(input: NudgeInput): Nudge | null {
  const { summary, job, computeAllowed, lastNudgedMissing } = input
  const missing = summary.missing
  if (missing <= 0) return null
  if (jobIsActive(job)) return null
  if (!computeAllowed) return null
  if (lastNudgedMissing !== null && missing <= lastNudgedMissing) return null
  return {
    missing,
    message: `${tracks(missing)} ${missing === 1 ? 'has' : 'have'} no ReplayGain`
  }
}

export type MeasureOutcome =
  | { kind: 'started'; total: number }
  | { kind: 'resumed'; pending: number }
  | { kind: 'running' }
  | { kind: 'nothing' }
  /** A selection measure (W25-7) whose selection resolved to no tracks. */
  | { kind: 'empty' }

/**
 * What a context-menu "Measure ReplayGain" names (W25-7): tracks, and albums
 * that main expands to every track they have.
 */
export interface ReplayGainScope {
  trackIds?: readonly number[]
  albumIds?: readonly number[]
}

/** Whether a scope names anything at all — an empty one never reaches main. */
export function scopeIsEmpty(scope: ReplayGainScope): boolean {
  return (scope.trackIds?.length ?? 0) === 0 && (scope.albumIds?.length ?? 0) === 0
}

/** The toast after a start from somewhere other than the control itself. */
export function measureOutcomeMessage(outcome: MeasureOutcome): string {
  switch (outcome.kind) {
    case 'started':
      return `Measuring ReplayGain for ${tracks(outcome.total)}`
    case 'resumed':
      return `Resumed measuring — ${tracks(outcome.pending)} left`
    case 'running':
      return 'ReplayGain is already being measured'
    case 'nothing':
      return 'Every track already has ReplayGain'
    case 'empty':
      return 'Nothing to measure in that selection'
  }
}

/**
 * Decide the verb for "measure" given what main last said: resume what exists,
 * otherwise start. Main enforces the same rule (`createJob` refuses beside a
 * resumable job); deciding it here keeps the palette and the nudge from
 * surfacing that refusal as an error.
 */
export function measureVerb(job: ReplayGainJobProgress | null): 'start' | 'resume' | 'running' {
  if (jobIsActive(job)) return 'running'
  if (jobIsResumable(job)) return 'resume'
  return 'start'
}
