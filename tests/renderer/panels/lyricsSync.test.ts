import { describe, expect, it } from 'vitest'
import type { LyricsLine } from '@shared/lyrics'
import {
  createLyricsCursor,
  createRafClock,
  estimateTimeMs,
  scrollFraction
} from '../../../src/renderer/panels/lyricsSync'

function timed(timeMs: number, text = `line ${timeMs}`): LyricsLine {
  return { timeMs, text }
}
function untimed(text: string): LyricsLine {
  return { timeMs: null, text }
}

describe('createLyricsCursor', () => {
  it('selects the last line at or before the time, and -1 before the first', () => {
    const cursor = createLyricsCursor([timed(0), timed(1000), timed(2000)])
    expect(cursor.activePosAt(-1)).toBe(-1)
    expect(cursor.activePosAt(0)).toBe(0)
    expect(cursor.activePosAt(999)).toBe(0)
    expect(cursor.activePosAt(1000)).toBe(1) // boundary is inclusive of the newer line
    expect(cursor.activePosAt(1999)).toBe(1)
    expect(cursor.activePosAt(2000)).toBe(2)
    expect(cursor.activePosAt(99999)).toBe(2)
  })

  it('survives a seek backwards — a stateless search cannot strand a cursor', () => {
    const cursor = createLyricsCursor([timed(0), timed(1000), timed(2000), timed(3000)])
    // Advance to the end, then jump back: the earlier line is selected correctly.
    expect(cursor.activePosAt(2500)).toBe(2)
    expect(cursor.activePosAt(500)).toBe(0)
    expect(cursor.activePosAt(1500)).toBe(1)
    expect(cursor.activePosAt(0)).toBe(0)
  })

  it('applies a positive offset by making lines land earlier (timeMs - offset)', () => {
    const cursor = createLyricsCursor([timed(1000), timed(2000)], 500)
    // Effective times are 500 and 1500.
    expect(cursor.activePosAt(400)).toBe(-1)
    expect(cursor.activePosAt(600)).toBe(0)
    expect(cursor.activePosAt(1600)).toBe(1)
    expect(cursor.entries[0]!.effMs).toBe(500)
  })

  it('applies a negative offset by making lines land later', () => {
    const cursor = createLyricsCursor([timed(1000)], -500)
    // Effective time is 1500.
    expect(cursor.activePosAt(1200)).toBe(-1)
    expect(cursor.activePosAt(1500)).toBe(0)
  })

  it('drops untimed lines and keeps the source index of the timed ones', () => {
    const lines = [untimed('intro'), timed(1000), untimed('spacer'), timed(2000)]
    const cursor = createLyricsCursor(lines)
    expect(cursor.entries).toHaveLength(2)
    expect(cursor.entries[0]!.srcIndex).toBe(1)
    expect(cursor.entries[1]!.srcIndex).toBe(3)
    expect(cursor.activePosAt(1500)).toBe(0)
  })

  it('a plain document (no timestamps) never selects a line', () => {
    const cursor = createLyricsCursor([untimed('a'), untimed('b'), untimed('c')])
    expect(cursor.entries).toHaveLength(0)
    expect(cursor.activePosAt(0)).toBe(-1)
    expect(cursor.activePosAt(100000)).toBe(-1)
  })
})

describe('estimateTimeMs', () => {
  it('holds at the anchor when paused, ignoring wall-clock drift', () => {
    expect(estimateTimeMs(10, 1000, false, 5000)).toBe(10_000)
  })

  it('interpolates forward from the anchor while playing', () => {
    expect(estimateTimeMs(10, 1000, true, 1250)).toBe(10_250)
  })

  it('never runs backwards if the wall clock predates the anchor', () => {
    expect(estimateTimeMs(10, 2000, true, 1000)).toBe(10_000)
  })
})

describe('scrollFraction', () => {
  it('is 0 on the last line (no next anchor)', () => {
    expect(scrollFraction(1000, null, 5000)).toBe(0)
  })

  it('is the linear progress between the two anchors', () => {
    expect(scrollFraction(1000, 2000, 1500)).toBe(0.5)
  })

  it('clamps to [0, 1] outside the pair', () => {
    expect(scrollFraction(1000, 2000, 500)).toBe(0)
    expect(scrollFraction(1000, 2000, 3000)).toBe(1)
  })

  it('is 0 when the anchors do not advance', () => {
    expect(scrollFraction(1000, 1000, 1000)).toBe(0)
  })
})

describe('createRafClock', () => {
  function scheduler() {
    let nextId = 1
    const queue = new Map<number, FrameRequestCallback>()
    const cancelled: number[] = []
    const raf = (cb: FrameRequestCallback): number => {
      const id = nextId++
      queue.set(id, cb)
      return id
    }
    const caf = (id: number): void => {
      cancelled.push(id)
      queue.delete(id)
    }
    const flush = (): void => {
      const pending = [...queue.values()]
      queue.clear()
      for (const cb of pending) cb(0)
    }
    return { raf, caf, flush, cancelled, size: () => queue.size }
  }

  it('schedules exactly one frame on start and never double-schedules', () => {
    const s = scheduler()
    const clock = createRafClock(() => {}, s.raf, s.caf)
    clock.start()
    expect(clock.running).toBe(true)
    expect(s.size()).toBe(1)
    clock.start()
    expect(s.size()).toBe(1)
  })

  it('calls onFrame each tick and reschedules', () => {
    const s = scheduler()
    let frames = 0
    const clock = createRafClock(
      () => {
        frames++
      },
      s.raf,
      s.caf
    )
    clock.start()
    s.flush()
    expect(frames).toBe(1)
    expect(s.size()).toBe(1) // rescheduled itself
    s.flush()
    expect(frames).toBe(2)
  })

  it('stop cancels the pending frame and halts the loop (leak check)', () => {
    const s = scheduler()
    let frames = 0
    const clock = createRafClock(
      () => {
        frames++
      },
      s.raf,
      s.caf
    )
    clock.start()
    clock.stop()
    expect(clock.running).toBe(false)
    expect(s.cancelled).toHaveLength(1)
    expect(s.size()).toBe(0)
    s.flush()
    expect(frames).toBe(0)
  })

  it('does not resurrect the loop when onFrame stops it mid-tick', () => {
    const s = scheduler()
    let frames = 0
    const clock: ReturnType<typeof createRafClock> = createRafClock(
      () => {
        frames++
        clock.stop()
      },
      s.raf,
      s.caf
    )
    clock.start()
    s.flush()
    expect(frames).toBe(1)
    expect(clock.running).toBe(false)
    expect(s.size()).toBe(0)
  })
})
