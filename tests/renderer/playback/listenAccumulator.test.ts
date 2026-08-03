import { describe, expect, it } from 'vitest'
import {
  beginListen,
  crossedThreshold,
  learnDuration,
  LISTEN_TIME_CAP_MS,
  listenProgress,
  observePosition,
  SEEK_EPSILON_MS,
  thresholdMs,
  type ListenState
} from '../../../src/renderer/playback/listenAccumulator'

/**
 * `DecodedAudioEngine`'s time-update cadence. The accumulator never sees a
 * timer, but the deltas it is fed in the running app arrive at this spacing,
 * and a test that fed it one delta per minute would not be testing the seek
 * epsilon at all.
 */
const TICK_MS = 250

const STARTED_AT = 1_770_000_000_000

/**
 * A playhead and the ticks it produces, so a test reads as the listening
 * session it describes rather than as arithmetic.
 *
 * Nothing here is async and nothing schedules: "play for a minute" is 240 folds
 * of `observePosition`, run instantly.
 */
function session(params: { durationMs?: number | null; startedAt?: number } = {}) {
  let state = beginListen({
    startedAt: params.startedAt ?? STARTED_AT,
    durationMs: params.durationMs ?? null
  })
  let positionMs = 0

  // The scheduler announces position 0 at transport-commit, which is what gives
  // the first real tick something to measure against.
  state = observePosition(state, positionMs, true)

  const api = {
    /** Play forward, one tick at a time. */
    play(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
        positionMs += TICK_MS
        state = observePosition(state, positionMs, true)
      }
      return api
    },
    /** Ticks keep arriving while paused; the playhead does not move. */
    pause(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
        state = observePosition(state, positionMs, false)
      }
      return api
    },
    /** Move the playhead and keep playing from there. */
    seekTo(ms: number) {
      positionMs = ms
      state = observePosition(state, positionMs, true)
      return api
    },
    learn(durationMs: number | null) {
      state = learnDuration(state, durationMs)
      return api
    },
    get state(): ListenState {
      return state
    },
    get progress() {
      return listenProgress(state)
    }
  }
  return api
}

describe('thresholdMs', () => {
  const cases: Array<{ name: string; durationMs: number | null; expected: number | null }> = [
    { name: 'a 25-second track can never be listened to', durationMs: 25_000, expected: null },
    {
      name: 'exactly thirty seconds is not longer than thirty',
      durationMs: 30_000,
      expected: null
    },
    { name: 'a hair over thirty seconds needs half of it', durationMs: 30_001, expected: 15_000.5 },
    { name: 'a three-minute track needs half', durationMs: 180_000, expected: 90_000 },
    { name: 'an eight-minute track is exactly at the cap', durationMs: 480_000, expected: 240_000 },
    { name: 'a thirty-minute track is capped', durationMs: 1_800_000, expected: 240_000 },
    { name: 'an unknown duration falls back to the cap', durationMs: null, expected: 240_000 }
  ]

  for (const { name, durationMs, expected } of cases) {
    it(name, () => {
      expect(thresholdMs(durationMs)).toBe(expected)
    })
  }

  it('caps at four minutes', () => {
    expect(LISTEN_TIME_CAP_MS).toBe(240_000)
  })
})

describe('beginListen', () => {
  it('stamps the transport-commit moment and starts from nothing', () => {
    expect(listenProgress(beginListen({ startedAt: STARTED_AT }))).toEqual({
      startedAt: STARTED_AT,
      msListened: 0,
      crossedThreshold: false
    })
  })

  /** A zero-length track would otherwise cross before it had played. */
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats a duration of %s as unknown',
    (durationMs) => {
      expect(beginListen({ startedAt: STARTED_AT, durationMs }).durationMs).toBeNull()
    }
  )
})

describe('learnDuration', () => {
  it('fills in a duration the library did not have', () => {
    const s = session({ durationMs: null }).play(100_000)
    expect(crossedThreshold(s.state)).toBe(false)
    s.learn(180_000)
    expect(crossedThreshold(s.state)).toBe(true)
  })

  it('never revises a duration already known', () => {
    const s = session({ durationMs: 180_000 }).learn(1_800_000)
    expect(s.state.durationMs).toBe(180_000)
  })

  it('ignores an unusable duration', () => {
    expect(session({ durationMs: null }).learn(0).state.durationMs).toBeNull()
  })
})

describe('the listened threshold', () => {
  it('never crosses on a 25-second track, however often it is replayed', () => {
    const s = session({ durationMs: 25_000 })
    // Ten passes through the whole track: 250 seconds of genuinely audible
    // time, well past the four-minute cap, and still not a listen.
    for (let pass = 0; pass < 10; pass += 1) {
      s.play(25_000).seekTo(0)
    }
    expect(s.progress.msListened).toBe(250_000)
    expect(s.progress.crossedThreshold).toBe(false)
  })

  it('crosses at exactly half a three-minute track', () => {
    const s = session({ durationMs: 180_000 }).play(90_000 - TICK_MS)
    expect(s.progress).toEqual({
      startedAt: STARTED_AT,
      msListened: 89_750,
      crossedThreshold: false
    })

    s.play(TICK_MS)
    expect(s.progress).toEqual({
      startedAt: STARTED_AT,
      msListened: 90_000,
      crossedThreshold: true
    })
  })

  it('crosses at the four-minute cap on a thirty-minute track, long before half', () => {
    const s = session({ durationMs: 1_800_000 }).play(240_000 - TICK_MS)
    expect(s.progress.crossedThreshold).toBe(false)

    s.play(TICK_MS)
    expect(s.progress.msListened).toBe(240_000)
    expect(s.progress.crossedThreshold).toBe(true)
    // Half of thirty minutes never came into it.
    expect(s.progress.msListened).toBeLessThan(900_000)
  })

  it('crosses at the cap when the duration is unknown', () => {
    const s = session({ durationMs: null }).play(240_000)
    expect(s.progress.crossedThreshold).toBe(true)
  })

  it('records the twenty minutes that happened, not the forty that did not', () => {
    const s = session({ durationMs: 2_400_000 }).play(1_200_000)
    expect(s.progress.msListened).toBe(1_200_000)
  })
})

describe('paused time', () => {
  it('does not count', () => {
    const s = session({ durationMs: 180_000 }).play(60_000).pause(600_000)
    expect(s.progress.msListened).toBe(60_000)
    expect(s.progress.crossedThreshold).toBe(false)
  })

  it('resumes accumulating, at a cost of the tick that re-establishes the baseline', () => {
    const s = session({ durationMs: 180_000 }).play(60_000).pause(600_000).play(30_000)
    expect(s.progress.msListened).toBe(89_750)
    expect(s.progress.crossedThreshold).toBe(false)

    s.play(TICK_MS)
    expect(s.progress.crossedThreshold).toBe(true)
  })

  it('does not credit a seek made while paused', () => {
    const s = session({ durationMs: 180_000 }).play(10_000).pause(1_000)
    // Dragging the handle to the far end of the track while stopped, then
    // pressing play, must not read as 160 seconds of listening.
    s.seekTo(170_000).play(5_000)
    expect(s.progress.msListened).toBe(15_000)
    expect(s.progress.crossedThreshold).toBe(false)
  })
})

describe('seeking', () => {
  it('does not cross by scrubbing past the threshold point', () => {
    const s = session({ durationMs: 180_000 }).play(10_000).seekTo(170_000).play(5_000)
    expect(s.progress.msListened).toBe(15_000)
    expect(s.progress.crossedThreshold).toBe(false)
  })

  it('does not cross by scrubbing through the whole track in steps', () => {
    const s = session({ durationMs: 180_000 })
    // A drag across the scrub bar, arriving as a run of large jumps.
    for (let target = 10_000; target <= 180_000; target += 10_000) {
      s.seekTo(target)
    }
    expect(s.progress.msListened).toBe(0)
    expect(s.progress.crossedThreshold).toBe(false)
  })

  it('counts a region played twice, twice', () => {
    const s = session({ durationMs: 180_000 }).play(60_000)
    expect(s.progress.crossedThreshold).toBe(false)

    s.seekTo(0).play(60_000)
    expect(s.progress.msListened).toBe(120_000)
    expect(s.progress.crossedThreshold).toBe(true)
  })

  it('credits a gap up to the epsilon and rejects one beyond it', () => {
    const credited = observePosition(
      observePosition(beginListen({ startedAt: STARTED_AT }), 0, true),
      SEEK_EPSILON_MS,
      true
    )
    expect(credited.msListened).toBe(SEEK_EPSILON_MS)

    const rejected = observePosition(
      observePosition(beginListen({ startedAt: STARTED_AT }), 0, true),
      SEEK_EPSILON_MS + 1,
      true
    )
    expect(rejected.msListened).toBe(0)
    // The baseline moves anyway, so playback after a seek accumulates normally.
    expect(rejected.lastPositionMs).toBe(SEEK_EPSILON_MS + 1)
  })
})

describe('repeat-one', () => {
  it('produces a fresh accumulator per pass, with its own startedAt', () => {
    const first = session({ durationMs: 180_000, startedAt: STARTED_AT }).play(120_000)
    const second = session({ durationMs: 180_000, startedAt: STARTED_AT + 120_000 }).play(120_000)

    expect(first.progress).toEqual({
      startedAt: STARTED_AT,
      msListened: 120_000,
      crossedThreshold: true
    })
    expect(second.progress).toEqual({
      startedAt: STARTED_AT + 120_000,
      msListened: 120_000,
      crossedThreshold: true
    })
  })

  it('does not let a second pass inherit the first pass towards the threshold', () => {
    const first = session({ durationMs: 180_000 }).play(60_000)
    expect(first.progress.crossedThreshold).toBe(false)

    const second = session({ durationMs: 180_000, startedAt: STARTED_AT + 60_000 }).play(60_000)
    expect(second.progress.msListened).toBe(60_000)
    expect(second.progress.crossedThreshold).toBe(false)
  })
})

describe('bad input', () => {
  it('drops the baseline on a non-finite position rather than poisoning the total', () => {
    const s = session({ durationMs: 180_000 }).play(60_000)
    const poisoned = observePosition(s.state, Number.NaN, true)
    expect(poisoned.msListened).toBe(60_000)
    expect(poisoned.lastPositionMs).toBeNull()

    // The next good tick re-baselines and accumulation carries on.
    const recovered = observePosition(
      observePosition(poisoned, 60_000, true),
      60_000 + TICK_MS,
      true
    )
    expect(recovered.msListened).toBe(60_250)
  })

  it('treats a negative position as the start of the track', () => {
    const state = observePosition(
      observePosition(beginListen({ startedAt: STARTED_AT }), -5_000, true),
      TICK_MS,
      true
    )
    expect(state.msListened).toBe(TICK_MS)
  })

  it('rounds the reported total, because ms_listened is an INTEGER', () => {
    let state = observePosition(beginListen({ startedAt: STARTED_AT }), 0, true)
    state = observePosition(state, 1000.4, true)
    state = observePosition(state, 2000.9, true)
    expect(state.msListened).toBeCloseTo(2000.9)
    expect(listenProgress(state).msListened).toBe(2001)
  })
})
