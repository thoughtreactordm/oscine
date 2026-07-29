import { estimateDecodePeakBytes, estimateDecodedBytes } from './decodedSize'

const MIB = 1024 ** 2

export interface R1Policy {
  /** Largest settled `AudioBuffer` admitted for one track. */
  maxTrackDecodedBytes: number
  /**
   * Conservative renderer residency ceiling. Admission reserves transient
   * decode growth on top of every issued buffer not yet proven collected.
   */
  maxDecodedResidencyBytes: number
}

/** Design R1 defaults. Both remain overrideable at the factory boundary. */
export const DEFAULT_R1_POLICY: Readonly<R1Policy> = Object.freeze({
  maxTrackDecodedBytes: 250 * MIB,
  maxDecodedResidencyBytes: 600 * MIB
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
  projectedResidencyBytes: number | null
  maxTrackDecodedBytes: number
  maxDecodedResidencyBytes: number
  targetSampleRateHz: number
}

export function resolveR1Policy(overrides: Partial<R1Policy> = {}): R1Policy {
  const policy = { ...DEFAULT_R1_POLICY, ...overrides }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite byte count.`)
    }
  }
  return policy
}

export function decideR1Admission(
  input: R1AdmissionInput,
  policy: R1Policy = DEFAULT_R1_POLICY
): R1AdmissionDecision {
  const issuedNotFreedBytes =
    Number.isFinite(input.issuedNotFreedBytes) && input.issuedNotFreedBytes > 0
      ? input.issuedNotFreedBytes
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

  const projectedResidencyBytes = issuedNotFreedBytes + reservation
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
