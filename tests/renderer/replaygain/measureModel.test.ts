import { describe, expect, it } from 'vitest'
import {
  COMPUTE_OFF_REASON,
  formatCount,
  measureOutcomeMessage,
  scopeIsEmpty,
  measureVerb,
  measureView,
  nudgeFor,
  type MeasureInput
} from '../../../src/renderer/replaygain/measureModel'
import type {
  ReplayGainJobProgress,
  ReplayGainJobState,
  ReplayGainSummary
} from '../../../src/shared/library'

/**
 * W25-1's renderer rules: the Measure control's state, the post-scan nudge and
 * the palette's outcome copy. No DOM, no `@renderer`.
 */

function summary(overrides: Partial<ReplayGainSummary> = {}): ReplayGainSummary {
  return { tagged: 10, computed: 0, missing: 1204, failed: 0, ...overrides }
}

function job(
  state: ReplayGainJobState,
  overrides: Partial<ReplayGainJobProgress> = {}
): ReplayGainJobProgress {
  return {
    jobId: 7,
    state,
    total: 1204,
    completed: 300,
    failed: 12,
    pending: 892,
    currentTitle: 'Blue in Green',
    updatedAt: '2026-11-15T00:00:00.000Z',
    done: state === 'completed' || state === 'cancelled',
    ...overrides
  }
}

function view(overrides: Partial<MeasureInput> = {}) {
  return measureView({
    summary: summary(),
    job: null,
    computeAllowed: true,
    busy: false,
    ...overrides
  })
}

describe('formatCount', () => {
  it('groups thousands the way the nudge copy is written', () => {
    expect(formatCount(1204)).toBe('1,204')
    expect(formatCount(0)).toBe('0')
  })
})

describe('measureView', () => {
  it('offers Start with the missing count when nothing has run', () => {
    const v = view()
    expect(v.primary).toEqual({ action: 'start', label: 'Measure 1,204 tracks', disabled: false })
    expect(v.cancel).toBeNull()
    expect(v.progress).toBeNull()
    expect(v.reason).toBeNull()
    expect(v.counts).toEqual(summary())
  })

  it('disables Start while the summary is still loading', () => {
    const v = view({ summary: null })
    expect(v.counts).toBeNull()
    expect(v.primary?.disabled).toBe(true)
  })

  it('disables Start with nothing to measure, and says so', () => {
    const v = view({ summary: summary({ missing: 0, computed: 50 }) })
    expect(v.primary).toMatchObject({ action: 'start', label: 'Measure', disabled: true })
    expect(v.status).toBe('Every track has ReplayGain.')
  })

  it('stays quiet about an empty library', () => {
    expect(view({ summary: summary({ tagged: 0, missing: 0 }) }).status).toBeNull()
  })

  it('disables Start with the reason when the gate is off', () => {
    const v = view({ computeAllowed: false })
    expect(v.primary?.disabled).toBe(true)
    expect(v.reason).toBe(COMPUTE_OFF_REASON)
  })

  it('disables the button while a request is in flight', () => {
    expect(view({ busy: true }).primary?.disabled).toBe(true)
  })

  it('says a retry is part of measuring when the last job failed some', () => {
    const v = view({ summary: summary({ missing: 3, failed: 3 }), job: job('completed') })
    expect(v.primary?.disabled).toBe(false)
    expect(v.status).toBe('3 tracks could not be decoded last time. Measuring retries them.')
  })

  it('shows progress, the current track and Cancel while running', () => {
    const v = view({ job: job('running') })
    expect(v.primary).toBeNull()
    expect(v.cancel).toEqual({ label: 'Cancel', disabled: false })
    expect(v.progress).toEqual({
      fraction: 312 / 1204,
      label: '312 of 1,204',
      currentTitle: 'Blue in Green'
    })
    expect(v.status).toBe('12 tracks could not be analyzed so far.')
  })

  it('locks Cancel and drops the title once a cancel is under way', () => {
    const v = view({ job: job('cancelling') })
    expect(v.cancel).toEqual({ label: 'Cancelling…', disabled: true })
    expect(v.progress?.currentTitle).toBeNull()
  })

  it('keeps Cancel live when the gate is turned off mid-job, and explains', () => {
    const v = view({ job: job('running'), computeAllowed: false })
    expect(v.cancel?.disabled).toBe(false)
    expect(v.reason).toMatch(/turned off after this job started/)
  })

  it('treats an empty running job as 0%, not NaN', () => {
    const v = view({ job: job('running', { total: 0, completed: 0, failed: 0 }) })
    expect(v.progress?.fraction).toBe(0)
  })

  it.each([
    ['paused', 'Interrupted with 892 tracks left.'],
    ['cancelled', 'Cancelled with 892 tracks left.']
  ] as const)('offers Resume in place of Start for a %s job', (state, status) => {
    const v = view({ job: job(state) })
    expect(v.primary).toEqual({ action: 'resume', label: 'Resume (892 left)', disabled: false })
    expect(v.status).toBe(status)
    expect(v.progress).toBeNull()
  })

  it('refuses Resume too when the gate is off', () => {
    const v = view({ job: job('paused'), computeAllowed: false })
    expect(v.primary?.disabled).toBe(true)
    expect(v.reason).toBe(COMPUTE_OFF_REASON)
  })
})

describe('nudgeFor', () => {
  const base = { summary: summary(), job: null, computeAllowed: true, lastNudgedMissing: null }

  it('speaks when a scan leaves untagged tracks, in the D37 copy', () => {
    expect(nudgeFor(base)).toEqual({ missing: 1204, message: '1,204 tracks have no ReplayGain' })
  })

  it('uses the singular for one track', () => {
    expect(nudgeFor({ ...base, summary: summary({ missing: 1 }) })?.message).toBe(
      '1 track has no ReplayGain'
    )
  })

  it('is silent with nothing missing', () => {
    expect(nudgeFor({ ...base, summary: summary({ missing: 0 }) })).toBeNull()
  })

  it.each(['running', 'cancelling'] as const)('is suppressed while a job is %s', (state) => {
    expect(nudgeFor({ ...base, job: job(state) })).toBeNull()
  })

  it('still speaks beside a paused or cancelled job — Measure resumes it', () => {
    expect(nudgeFor({ ...base, job: job('paused') })).not.toBeNull()
  })

  it('is suppressed while the gate is off', () => {
    expect(nudgeFor({ ...base, computeAllowed: false })).toBeNull()
  })

  it('does not repeat a count already announced, or a smaller one', () => {
    expect(nudgeFor({ ...base, lastNudgedMissing: 1204 })).toBeNull()
    expect(nudgeFor({ ...base, lastNudgedMissing: 2000 })).toBeNull()
    expect(nudgeFor({ ...base, lastNudgedMissing: 1000 })?.missing).toBe(1204)
  })
})

describe('measureVerb', () => {
  it('resumes what exists, otherwise starts', () => {
    expect(measureVerb(null)).toBe('start')
    expect(measureVerb(job('completed'))).toBe('start')
    expect(measureVerb(job('paused'))).toBe('resume')
    expect(measureVerb(job('cancelled'))).toBe('resume')
    expect(measureVerb(job('running'))).toBe('running')
    expect(measureVerb(job('cancelling'))).toBe('running')
  })
})

describe('measureOutcomeMessage', () => {
  it('names what happened', () => {
    expect(measureOutcomeMessage({ kind: 'started', total: 1204 })).toBe(
      'Measuring ReplayGain for 1,204 tracks'
    )
    expect(measureOutcomeMessage({ kind: 'resumed', pending: 1 })).toBe(
      'Resumed measuring — 1 track left'
    )
    expect(measureOutcomeMessage({ kind: 'running' })).toBe('ReplayGain is already being measured')
    expect(measureOutcomeMessage({ kind: 'nothing' })).toBe('Every track already has ReplayGain')
  })
})

describe('selection measure (W25-7)', () => {
  it('treats a scope naming nothing as empty', () => {
    expect(scopeIsEmpty({})).toBe(true)
    expect(scopeIsEmpty({ trackIds: [], albumIds: [] })).toBe(true)
    expect(scopeIsEmpty({ trackIds: [1] })).toBe(false)
    expect(scopeIsEmpty({ albumIds: [4] })).toBe(false)
  })

  it('says so when a selection resolved to no tracks', () => {
    expect(measureOutcomeMessage({ kind: 'empty' })).toBe('Nothing to measure in that selection')
  })
})
