import {
  AUDIO_DECODE_RESIDENCY_BUDGET_MB,
  AUDIO_DECODE_TRACK_CAP_MB,
  AUDIO_NUMERIC_BOUNDS,
  MIB
} from '@shared/settings'
import { estimateDecodePeakBytes, estimateDecodedBytes } from './decodedSize'

export interface R1Policy {
  /** Largest settled `AudioBuffer` admitted for one track. */
  maxTrackDecodedBytes: number
  /**
   * Conservative renderer residency ceiling. Admission reserves transient
   * decode growth on top of every issued buffer not yet proven collected.
   */
  maxDecodedResidencyBytes: number
}

/**
 * Design R1 defaults, read from the registry rather than declared here.
 *
 * W8-9's rule is that no audio default lives outside `SETTINGS_REGISTRY`, and
 * this is the awkward case it was written for: `decideR1Admission` is a pure
 * function on the hot path with no store to consult, so it needs a value at
 * module scope. It gets one — the descriptor's default, which is the same number
 * the settings view shows and the same number an untouched install runs with.
 */
export const DEFAULT_R1_POLICY: Readonly<R1Policy> = Object.freeze({
  maxTrackDecodedBytes: AUDIO_DECODE_TRACK_CAP_MB.default * MIB,
  maxDecodedResidencyBytes: AUDIO_DECODE_RESIDENCY_BUDGET_MB.default * MIB
})

/**
 * The guard's own bounds, in bytes.
 *
 * The descriptors clamp too, and that clamp is the one an operator sees. This is
 * the one that has to hold: `resolveR1Policy` is reachable from a test, from a
 * future caller that builds a policy from something other than settings, and
 * from a stored value written by a build whose descriptor bounds differed. R1's
 * invariant is that the memory guard ships *with* the decode path — a guard
 * whose ceiling could be raised from outside would not be one.
 */
export const R1_POLICY_LIMITS = Object.freeze({
  maxTrackDecodedBytes: Object.freeze({
    min: AUDIO_NUMERIC_BOUNDS.decodeTrackCapMb.min * MIB,
    max: AUDIO_NUMERIC_BOUNDS.decodeTrackCapMb.max * MIB
  }),
  maxDecodedResidencyBytes: Object.freeze({
    min: AUDIO_NUMERIC_BOUNDS.decodeResidencyBudgetMb.min * MIB,
    max: AUDIO_NUMERIC_BOUNDS.decodeResidencyBudgetMb.max * MIB
  })
})

export type R1AdmissionReason =
  'within-budget' | 'unpriceable' | 'per-track-cap' | 'residency-budget'

export interface R1AdmissionInput {
  trackId: number
  durationSec: number | null
  channels: number | null
  encodedBytes: number
  targetSampleRateHz: number
  issuedNotFreedBytes: number
  reservedDecodeBytes: number
}

/**
 * Bytes promised to decodes which have been admitted but have not settled.
 *
 * This sits beside the proven-freed buffer ledger: one prices work already
 * issued by Web Audio, the other prevents concurrent current/prefetch or stale
 * superseded decodes from each spending the same remaining headroom.
 */
export class R1ReservationLedger {
  #reservedBytes = 0

  get reservedBytes(): number {
    return this.#reservedBytes
  }

  reserve(bytes: number): () => void {
    const amount = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
    this.#reservedBytes += amount
    let released = false
    return () => {
      if (released) return
      released = true
      this.#reservedBytes = Math.max(0, this.#reservedBytes - amount)
    }
  }
}

/**
 * A path decision and all numbers needed to explain it. This object is safe to
 * log: it contains an opaque library id and arithmetic, never a URL or path.
 */
export interface R1AdmissionDecision {
  trackId: number
  path: 'decoded' | 'streaming'
  reason: R1AdmissionReason
  transitionPolicy: 'sample-accurate' | 'hard'
  estimatedDecodedBytes: number | null
  transientReservationBytes: number | null
  issuedNotFreedBytes: number
  reservedDecodeBytes: number
  projectedResidencyBytes: number | null
  maxTrackDecodedBytes: number
  maxDecodedResidencyBytes: number
  targetSampleRateHz: number
}

/**
 * Build the policy the guard will actually enforce.
 *
 * Two steps, and they answer two different kinds of wrong. A value that is not a
 * positive finite byte count is a *programming* error at the factory boundary
 * and still throws — no settings path can produce one, because the descriptors
 * reject a non-number before it ever gets here. A value that is merely out of
 * the safe range is clamped, because that one an operator can produce, and
 * answering it with a crash on launch would be a worse outcome than answering it
 * with a smaller budget.
 *
 * The two numbers are clamped independently and nothing reconciles them,
 * deliberately. A residency budget below the per-track cap is not a
 * contradiction to be repaired: the cap prices one settled buffer while the
 * budget prices current plus prefetch plus the transient decode peak, which
 * `estimateDecodePeakBytes` already puts at roughly twice the settled size. A
 * budget under the cap is simply a stricter overall limit, and the tracks that
 * do not fit stream — which is the guard working, not the guard misconfigured.
 * An earlier draft of this function raised the budget to meet the cap and so
 * quietly handed an operator more memory than they asked for.
 */
export function resolveR1Policy(overrides: Partial<R1Policy> = {}): R1Policy {
  const requested = { ...DEFAULT_R1_POLICY, ...overrides }
  for (const [name, value] of Object.entries(requested)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite byte count.`)
    }
  }

  return {
    maxTrackDecodedBytes: clamp(
      requested.maxTrackDecodedBytes,
      R1_POLICY_LIMITS.maxTrackDecodedBytes
    ),
    maxDecodedResidencyBytes: clamp(
      requested.maxDecodedResidencyBytes,
      R1_POLICY_LIMITS.maxDecodedResidencyBytes
    )
  }
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(Math.max(value, bounds.min), bounds.max)
}

export function decideR1Admission(
  input: R1AdmissionInput,
  policy: R1Policy = DEFAULT_R1_POLICY
): R1AdmissionDecision {
  const issuedNotFreedBytes =
    Number.isFinite(input.issuedNotFreedBytes) && input.issuedNotFreedBytes > 0
      ? input.issuedNotFreedBytes
      : 0
  const reservedDecodeBytes =
    Number.isFinite(input.reservedDecodeBytes) && input.reservedDecodeBytes > 0
      ? input.reservedDecodeBytes
      : 0
  const estimated = estimateDecodedBytes(
    input.durationSec,
    input.targetSampleRateHz,
    input.channels
  )
  const reservation = estimateDecodePeakBytes(estimated, input.encodedBytes)
  const common = {
    trackId: input.trackId,
    issuedNotFreedBytes,
    reservedDecodeBytes,
    maxTrackDecodedBytes: policy.maxTrackDecodedBytes,
    maxDecodedResidencyBytes: policy.maxDecodedResidencyBytes,
    targetSampleRateHz: input.targetSampleRateHz
  }

  if (estimated === 0 || reservation === 0) {
    return {
      ...common,
      path: 'streaming',
      reason: 'unpriceable',
      transitionPolicy: 'hard',
      estimatedDecodedBytes: null,
      transientReservationBytes: null,
      projectedResidencyBytes: null
    }
  }

  const projectedResidencyBytes = issuedNotFreedBytes + reservedDecodeBytes + reservation
  if (estimated > policy.maxTrackDecodedBytes) {
    return {
      ...common,
      path: 'streaming',
      reason: 'per-track-cap',
      transitionPolicy: 'hard',
      estimatedDecodedBytes: estimated,
      transientReservationBytes: reservation,
      projectedResidencyBytes
    }
  }

  if (projectedResidencyBytes > policy.maxDecodedResidencyBytes) {
    return {
      ...common,
      path: 'streaming',
      reason: 'residency-budget',
      transitionPolicy: 'hard',
      estimatedDecodedBytes: estimated,
      transientReservationBytes: reservation,
      projectedResidencyBytes
    }
  }

  return {
    ...common,
    path: 'decoded',
    reason: 'within-budget',
    transitionPolicy: 'sample-accurate',
    estimatedDecodedBytes: estimated,
    transientReservationBytes: reservation,
    projectedResidencyBytes
  }
}
