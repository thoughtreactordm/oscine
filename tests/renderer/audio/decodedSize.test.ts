import { describe, expect, it } from 'vitest'
import {
  decodedBytes,
  estimateDecodePeakBytes,
  estimateDecodedBytes,
  formatBytes
} from '../../../src/renderer/audio/decodedSize'

/**
 * R1's arithmetic. `estimateDecodedBytes` feeds M2's peak-cost calculation, so
 * the figures the design document quotes are pinned here — if this drifts, the
 * guard's default cap stops meaning what it was chosen to mean.
 */

describe('estimateDecodedBytes', () => {
  it("prices a 44.1 kHz file at the AudioContext's 48 kHz target rate", () => {
    // The M1 exit probe decoded this one-hour fixture at 48kHz even though its
    // source metadata says 44.1kHz. The source rate is deliberately not passed.
    const durationSec = 3600
    const audioContextSampleRateHz = 48_000
    const channels = 2

    expect(estimateDecodedBytes(durationSec, audioContextSampleRateHz, channels)).toBe(
      1_382_400_000
    )
  })

  it('matches the design document figure for a five-minute stereo track', () => {
    // D2/R1 quote ~105MB when both source and target happen to be 44.1kHz.
    const bytes = estimateDecodedBytes(300, 44_100, 2)
    expect(bytes).toBe(105_840_000)
  })

  it('matches the design document figure for a twenty-minute mix', () => {
    // R1 calls this one out by name, on a 44.1kHz target, as the case that makes
    // a collection crash.
    const bytes = estimateDecodedBytes(1200, 44_100, 2)
    expect(bytes).toBe(423_360_000)
  })

  it('scales with channel count and target sample rate', () => {
    expect(estimateDecodedBytes(60, 96_000, 6)).toBe(138_240_000)
  })

  it('returns zero when any input is unknown', () => {
    // Deliberate: an unpriceable track is M2's decision to make explicitly, not
    // something this function should guess a default for.
    expect(estimateDecodedBytes(null, 44_100, 2)).toBe(0)
    expect(estimateDecodedBytes(300, null, 2)).toBe(0)
    expect(estimateDecodedBytes(300, 44_100, null)).toBe(0)
  })

  it('returns zero for nonsense input rather than a negative size', () => {
    expect(estimateDecodedBytes(-300, 44_100, 2)).toBe(0)
  })
})

describe('estimateDecodePeakBytes', () => {
  it('budgets the measured decode transient plus the encoded buffer', () => {
    // The cross-platform probe fixture: a one-hour stereo decode at 48kHz,
    // alongside its exact 41.4MiB encoded file.
    const decodedBytes = estimateDecodedBytes(3600, 48_000, 2)
    const encodedBytes = 43_362_659

    expect(estimateDecodePeakBytes(decodedBytes, encodedBytes)).toBe(2_808_162_659)
  })

  it('preserves an unknown decoded cost rather than pricing only the file', () => {
    expect(estimateDecodePeakBytes(0, 43_362_659)).toBe(0)
  })

  it('returns zero for a negative byte count', () => {
    expect(estimateDecodePeakBytes(100, -1)).toBe(0)
  })
})

describe('decodedBytes', () => {
  it('costs four bytes per sample per channel', () => {
    expect(decodedBytes(44_100, 2)).toBe(352_800)
  })

  it('returns zero for an empty buffer', () => {
    expect(decodedBytes(0, 2)).toBe(0)
    expect(decodedBytes(44_100, 0)).toBe(0)
  })
})

describe('formatBytes', () => {
  it('reports small sizes in bytes', () => {
    expect(formatBytes(512)).toBe('512B')
  })

  it('steps up through binary units', () => {
    expect(formatBytes(1536)).toBe('1.5KiB')
    expect(formatBytes(105_840_000)).toBe('100.9MiB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0GiB')
  })
})
