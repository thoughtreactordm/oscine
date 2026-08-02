import { describe, expect, it } from 'vitest'
import { createRateLimiter, RateLimitAbortedError } from '../../../src/main/net/rateLimiter'

/**
 * A clock the test advances by hand.
 *
 * Real timers would make the headline case — twenty requests at one per second
 * — a twenty-second test, and fake timers alone would not: `Date.now` and the
 * timer queue have to move together or the limiter's arithmetic reads a clock
 * that disagrees with the callback that woke it.
 */
function testClock() {
  let current = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()

  return {
    now: () => current,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = nextId++
      pending.set(id, { at: current + ms, fn })
      return id
    },
    clearTimer: (handle: unknown): void => {
      pending.delete(handle as number)
    },
    /** Move to `to`, firing every timer due on the way in due order. */
    async advanceTo(to: number): Promise<void> {
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= to)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [id, timer] = due
        pending.delete(id)
        current = timer.at
        timer.fn()
        // Let the promise the timer resolved actually settle before deciding
        // what is due next — a released waiter schedules the following one.
        await Promise.resolve()
        await Promise.resolve()
      }
      current = to
      await Promise.resolve()
    }
  }
}

describe('createRateLimiter', () => {
  it('spaces twenty concurrent requests one interval apart', async () => {
    const clock = testClock()
    const limiter = createRateLimiter({
      minIntervalMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    const startedAt: number[] = []
    const all = Array.from({ length: 20 }, () =>
      limiter.acquire('musicbrainz.org').then(() => {
        startedAt.push(clock.now())
      })
    )

    // Nothing has been waited on yet, so only the first may have gone.
    await Promise.resolve()
    await Promise.resolve()
    expect(startedAt).toEqual([0])

    await clock.advanceTo(19_000)
    await Promise.all(all)

    expect(startedAt).toHaveLength(20)
    expect(startedAt).toEqual(Array.from({ length: 20 }, (_, index) => index * 1_000))

    // The observed spacing, stated as the acceptance criterion states it.
    const gaps = startedAt.slice(1).map((at, index) => at - startedAt[index])
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1_000)
  })

  it('keeps hosts independent', async () => {
    const clock = testClock()
    const limiter = createRateLimiter({
      minIntervalMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    const order: string[] = []
    const both = [
      limiter.acquire('musicbrainz.org').then(() => order.push('mb')),
      limiter.acquire('wikipedia.org').then(() => order.push('wp'))
    ]

    await clock.advanceTo(0)
    await Promise.all(both)

    // Two hosts, two first requests, neither waiting on the other.
    expect(order.sort()).toEqual(['mb', 'wp'])
  })

  it('rejects a waiter when its signal aborts, and leaves the queue intact', async () => {
    const clock = testClock()
    const limiter = createRateLimiter({
      minIntervalMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    const first = limiter.acquire('musicbrainz.org')
    const controller = new AbortController()
    const cancelled = limiter.acquire('musicbrainz.org', controller.signal)
    const third = limiter.acquire('musicbrainz.org')

    await clock.advanceTo(0)
    await first

    controller.abort(new Error('deck closed'))
    await expect(cancelled).rejects.toBeInstanceOf(RateLimitAbortedError)

    // The cancelled waiter left; the one behind it takes the next slot rather
    // than the one after.
    await clock.advanceTo(1_000)
    await third
    expect(clock.now()).toBe(1_000)
    expect(limiter.waiting('musicbrainz.org')).toBe(0)
  })

  /**
   * The failure the FIFO design exists to prevent, stated as a test so the
   * cheaper `nextAllowedAt` implementation cannot come back unnoticed.
   */
  it('does not hold the interval against a burst that was entirely cancelled', async () => {
    const clock = testClock()
    const limiter = createRateLimiter({
      minIntervalMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    const controller = new AbortController()
    const burst = Array.from({ length: 20 }, () =>
      limiter.acquire('musicbrainz.org', controller.signal).catch(() => 'aborted')
    )

    await clock.advanceTo(0)
    controller.abort(new Error('deck closed'))
    await Promise.all(burst)
    expect(limiter.waiting('musicbrainz.org')).toBe(0)

    // Reopening immediately: the first request of the new burst waits one
    // interval behind the one request the old burst actually made, not twenty.
    let releasedAt = -1
    const reopened = limiter.acquire('musicbrainz.org').then(() => {
      releasedAt = clock.now()
    })
    await clock.advanceTo(1_000)
    await reopened
    expect(releasedAt).toBe(1_000)
  })

  it('refuses immediately when handed an already-aborted signal', async () => {
    const limiter = createRateLimiter({ minIntervalMs: 1_000 })
    const controller = new AbortController()
    controller.abort(new Error('gone'))

    await expect(limiter.acquire('musicbrainz.org', controller.signal)).rejects.toBeInstanceOf(
      RateLimitAbortedError
    )
    expect(limiter.waiting('musicbrainz.org')).toBe(0)
  })
})
