import { describe, expect, it } from 'vitest'
import {
  decodedBytes,
  estimateDecodedBytes,
  formatBytes
} from '../../../src/renderer/audio/decodedSize'

/**
 * R1's arithmetic. `estimateDecodedBytes` is what M2's memory guard will
 * threshold on, so the figures the design document quotes are pinned here —
 * if this drifts, the guard's default cap stops meaning what it was chosen to
 * mean.
 */

describe('estimateDecodedBytes', () => {
  it('matches the design document figure for a five-minute stereo track', () => {
    // D2/R1 quote ~105MB for 5 minutes of 44.1kHz stereo.
    const bytes = estimateDecodedBytes(300, 44_100, 2)
    expect(bytes).toBe(105_840_000)
  })

  it('matches the design document figure for a twenty-minute mix', () => {
    // R1 calls this one out by name as the case that makes a collection crash.
    const bytes = estimateDecodedBytes(1200, 44_100, 2)
    expect(bytes).toBe(423_360_000)
  })

  it('scales with channel count and sample rate', () => {
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
