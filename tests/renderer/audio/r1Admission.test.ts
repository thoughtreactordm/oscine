import { describe, expect, it } from 'vitest'
import {
  DEFAULT_R1_POLICY,
  decideR1Admission,
  resolveR1Policy,
  type R1AdmissionInput,
  type R1Policy
} from '../../../src/renderer/audio/r1Admission'

const MIB = 1024 ** 2

function input(overrides: Partial<R1AdmissionInput> = {}): R1AdmissionInput {
  return {
    trackId: 7,
    durationSec: 60,
    channels: 2,
    encodedBytes: 5 * MIB,
    targetSampleRateHz: 48_000,
    issuedNotFreedBytes: 0,
    ...overrides
  }
}

describe('R1 admission policy', () => {
  it('ships the configurable 250 MiB / 600 MiB design defaults', () => {
    expect(DEFAULT_R1_POLICY).toEqual({
      maxTrackDecodedBytes: 250 * MIB,
      maxDecodedResidencyBytes: 600 * MIB
    })
    expect(resolveR1Policy({ maxTrackDecodedBytes: 64 * MIB }).maxTrackDecodedBytes).toBe(64 * MIB)
  })

  it('admits a track exactly on both inclusive boundaries', () => {
    const durationSec = (250 * MIB) / (48_000 * 2 * 4)
    const encodedBytes = 10 * MIB
    const policy: R1Policy = {
      maxTrackDecodedBytes: 250 * MIB,
      maxDecodedResidencyBytes: 510 * MIB
    }

    const decision = decideR1Admission(
      input({ durationSec, encodedBytes, issuedNotFreedBytes: 0 }),
      policy
    )

    expect(decision.path).toBe('decoded')
    expect(decision.estimatedDecodedBytes).toBe(250 * MIB)
    expect(decision.projectedResidencyBytes).toBe(510 * MIB)
  })

  it('streams one byte above the per-track settled cap', () => {
    const durationSec = (250 * MIB + 1) / (48_000 * 2 * 4)
    const decision = decideR1Admission(input({ durationSec }))

    expect(decision).toMatchObject({
      path: 'streaming',
      reason: 'per-track-cap',
      transitionPolicy: 'hard',
      estimatedDecodedBytes: 250 * MIB + 1
    })
  })

  it('prices at the runtime context rate and reserves decoded x2 plus encoded', () => {
    const decision = decideR1Admission(
      input({
        durationSec: 300,
        targetSampleRateHz: 48_000,
        encodedBytes: 12_345
      })
    )

    expect(decision.estimatedDecodedBytes).toBe(115_200_000)
    expect(decision.transientReservationBytes).toBe(230_412_345)
  })

  it('counts issued-but-uncollected buffers against transient headroom', () => {
    const decodedBytes = 100 * MIB
    const durationSec = decodedBytes / (48_000 * 2 * 4)
    const reservation = 2 * decodedBytes + 5 * MIB
    const issuedNotFreedBytes = DEFAULT_R1_POLICY.maxDecodedResidencyBytes - reservation + 1

    const decision = decideR1Admission(input({ durationSec, issuedNotFreedBytes }))

    expect(decision.path).toBe('streaming')
    expect(decision.reason).toBe('residency-budget')
    expect(decision.projectedResidencyBytes).toBe(DEFAULT_R1_POLICY.maxDecodedResidencyBytes + 1)
  })

  it('streams metadata it cannot price instead of interpreting it as free', () => {
    for (const unknown of [
      input({ durationSec: null }),
      input({ channels: null }),
      input({ encodedBytes: -1 })
    ]) {
      expect(decideR1Admission(unknown)).toMatchObject({
        path: 'streaming',
        reason: 'unpriceable',
        estimatedDecodedBytes: null,
        transientReservationBytes: null
      })
    }
  })

  it('rejects invalid configuration rather than silently disabling a limit', () => {
    expect(() => resolveR1Policy({ maxTrackDecodedBytes: 0 })).toThrow(TypeError)
    expect(() => resolveR1Policy({ maxDecodedResidencyBytes: Number.POSITIVE_INFINITY })).toThrow(
      TypeError
    )
  })
})
