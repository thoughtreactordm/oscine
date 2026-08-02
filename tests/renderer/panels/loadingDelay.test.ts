import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import {
  LOADING_DELAY_MS,
  useDeferredFlag
} from '../../../src/renderer/panels/tunedeck/loadingDelay'

/**
 * The timing rules behind the biography's placeholder.
 *
 * Every assertion here is a bug that is invisible in review and obvious on
 * screen: a placeholder that flashes for one frame on every track change, one
 * that appears a moment *after* the content it was covering for, and one left
 * behind by a timer that outlived its component.
 */

let scope: ReturnType<typeof effectScope>

/** Runs the composable in a scope, so disposal is testable rather than implied. */
function deferred(source: () => boolean, delayMs?: number): { value: boolean } {
  const flag = scope.run(() => useDeferredFlag(source, delayMs))!
  return flag
}

beforeEach(() => {
  vi.useFakeTimers()
  scope = effectScope()
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
})

describe('deferred loading flag', () => {
  it('stays down while a wait is shorter than the delay', async () => {
    const waiting = ref(true)
    const flag = deferred(() => waiting.value)

    vi.advanceTimersByTime(LOADING_DELAY_MS - 1)
    waiting.value = false
    await nextTick()

    // The case that made this exist: an artist matched once resolves from
    // SQLite, and a placeholder shown for that is a strobe, not progress.
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    expect(flag.value).toBe(false)
  })

  it('comes up once a wait outlasts the delay', () => {
    const waiting = ref(true)
    const flag = deferred(() => waiting.value)

    vi.advanceTimersByTime(LOADING_DELAY_MS - 1)
    expect(flag.value).toBe(false)

    vi.advanceTimersByTime(1)
    expect(flag.value).toBe(true)
  })

  it('goes down the instant the wait ends', async () => {
    const waiting = ref(true)
    const flag = deferred(() => waiting.value)
    vi.advanceTimersByTime(LOADING_DELAY_MS)
    expect(flag.value).toBe(true)

    waiting.value = false
    await nextTick()
    // No delay on the way down. Slow to admit, quick to forget — a placeholder
    // lingering over content that has arrived is the same jank in reverse.
    expect(flag.value).toBe(false)
  })

  it('treats a wait that stops and restarts as two short waits', async () => {
    const waiting = ref(true)
    const flag = deferred(() => waiting.value)

    vi.advanceTimersByTime(LOADING_DELAY_MS - 20)
    waiting.value = false
    await nextTick()
    waiting.value = true
    await nextTick()

    // Skipping twice quickly. Carrying the first wait's elapsed time into the
    // second would raise the flag 20ms into a fresh lookup.
    vi.advanceTimersByTime(LOADING_DELAY_MS - 1)
    expect(flag.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(flag.value).toBe(true)
  })

  it('is down for a wait that never starts', () => {
    const flag = deferred(() => false)
    vi.advanceTimersByTime(LOADING_DELAY_MS * 10)
    expect(flag.value).toBe(false)
  })

  it('cancels its timer when the scope goes away', async () => {
    const waiting = ref(true)
    const flag = deferred(() => waiting.value)

    scope.stop()
    vi.advanceTimersByTime(LOADING_DELAY_MS * 2)
    await nextTick()

    // A dock host reparenting the deck unmounts this. A timer that survives
    // fires into a dead component.
    expect(flag.value).toBe(false)
  })

  it('honours a delay of its own', () => {
    const flag = deferred(() => true, 500)
    vi.advanceTimersByTime(499)
    expect(flag.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect(flag.value).toBe(true)
  })
})
