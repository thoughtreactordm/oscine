import { describe, expect, it } from 'vitest'
import {
  SCROBBLE_BACKOFF_BASE_MS,
  SCROBBLE_BACKOFF_MAX_MS,
  backoffDelayMs
} from '../../../src/main/scrobble/backoff'

/** A random source that always sits at one end of the jitter window. */
const lowest = (): number => 0
const highest = (): number => 1

describe('backoffDelayMs', () => {
  it('grows with every attempt', () => {
    const delays = [0, 1, 2, 3, 4].map((attempts) => backoffDelayMs({ attempts, random: lowest }))

    // Strictly increasing, and not merely different: a curve that wobbles is a
    // curve that can send a row that has failed four times back onto the wire
    // sooner than one that failed twice.
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1])
    }
  })

  it('is bounded, however long a row has been failing', () => {
    // The ceiling is the property that matters: a fortnight offline must not
    // schedule the next attempt a month out.
    for (const attempts of [10, 20, 40, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(backoffDelayMs({ attempts, random: highest })).toBeLessThanOrEqual(
        SCROBBLE_BACKOFF_MAX_MS
      )
    }
  })

  it('reaches the ceiling rather than approaching it', () => {
    expect(backoffDelayMs({ attempts: 30, random: highest })).toBe(SCROBBLE_BACKOFF_MAX_MS)
  })

  it('jitters within the top half of the window, never below it', () => {
    const attempts = 3
    const nominal = SCROBBLE_BACKOFF_BASE_MS * 2 ** attempts

    expect(backoffDelayMs({ attempts, random: lowest })).toBe(nominal / 2)
    expect(backoffDelayMs({ attempts, random: highest })).toBe(nominal)
    expect(backoffDelayMs({ attempts, random: () => 0.5 })).toBe(nominal * 0.75)
  })

  it('never returns zero, so a rescheduled row cannot be reclaimed immediately', () => {
    expect(backoffDelayMs({ attempts: 0, random: lowest, baseMs: 0, maxMs: 0 })).toBeGreaterThan(0)
  })

  it('honours a Retry-After past the ceiling', () => {
    const requested = SCROBBLE_BACKOFF_MAX_MS / 1000 + 3_600

    // The service knows something the curve does not. Ignoring it is how an
    // account gets throttled harder than it already was.
    expect(backoffDelayMs({ attempts: 0, retryAfterSeconds: requested, random: highest })).toBe(
      requested * 1000
    )
  })

  it('lets a Retry-After raise the delay but never lower it', () => {
    const attempts = 8
    const withoutHint = backoffDelayMs({ attempts, random: highest })

    expect(backoffDelayMs({ attempts, retryAfterSeconds: 1, random: highest })).toBe(withoutHint)
  })

  it('ignores a random source that misbehaves', () => {
    const nominal = SCROBBLE_BACKOFF_BASE_MS
    expect(backoffDelayMs({ attempts: 0, random: () => Number.NaN })).toBe(nominal / 2)
    expect(backoffDelayMs({ attempts: 0, random: () => 4 })).toBe(nominal)
    expect(backoffDelayMs({ attempts: 0, random: () => -1 })).toBe(nominal / 2)
  })
})
