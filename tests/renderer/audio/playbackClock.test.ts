import { describe, expect, it } from 'vitest'
import { clamp, pausedAt, positionAt } from '../../../src/renderer/audio/playbackClock'

/**
 * The engine derives position from the AudioContext clock rather than counting
 * it. These cover the arithmetic that makes that safe; the Web Audio wiring
 * around it is verified by hand against real files (see the card outcome).
 */

describe('positionAt', () => {
  it('reports the offset while parked', () => {
    // A paused clock ignores the context time entirely — the context clock
    // keeps advancing while paused, and reading it would fast-forward the UI.
    expect(positionAt(pausedAt(30), 999, 200)).toBe(30)
  })

  it('advances with the context clock while running', () => {
    const clock = { offsetSec: 10, startedAtSec: 100 }
    expect(positionAt(clock, 104.5, 200)).toBe(14.5)
  })

  it('clamps to the duration once the buffer has run out', () => {
    // The source stops at the end but the context clock does not, so the raw
    // sum overshoots between the last frame and the ended event landing.
    const clock = { offsetSec: 0, startedAtSec: 100 }
    expect(positionAt(clock, 400, 180)).toBe(180)
  })

  it('never reports a negative position', () => {
    expect(positionAt({ offsetSec: -5, startedAtSec: null }, 0, 180)).toBe(0)
  })

  it('ignores a context clock that reads before the start', () => {
    // Not expected in practice, but a negative elapsed would rewind the UI
    // rather than simply being wrong.
    const clock = { offsetSec: 20, startedAtSec: 100 }
    expect(positionAt(clock, 90, 180)).toBe(20)
  })

  it('reports zero when nothing is loaded', () => {
    expect(positionAt(pausedAt(0), 12, 0)).toBe(0)
  })

  it('survives a negative duration', () => {
    expect(positionAt(pausedAt(5), 0, -1)).toBe(0)
  })
})

describe('clamp', () => {
  it('bounds on both sides', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  it('collapses non-finite input to the minimum', () => {
    // NaN fails every comparison, so Math.min/Math.max would pass it straight
    // through and poison every position derived from it afterwards.
    expect(clamp(Number.NaN, 0, 10)).toBe(0)
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(0)
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0)
  })
})

describe('pausedAt', () => {
  it('produces a clock that is not running', () => {
    expect(pausedAt(42)).toEqual({ offsetSec: 42, startedAtSec: null })
  })
})
