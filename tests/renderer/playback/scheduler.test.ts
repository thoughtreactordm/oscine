import { describe, expect, it, vi } from 'vitest'
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type AudioTransitionPolicy,
  type NormalizationPolicy,
  type PlaybackStatus,
  type SampleAccurateTime
} from '../../../src/renderer/audio/AudioEngine'
import { DEFAULT_R1_POLICY, type R1Policy } from '../../../src/renderer/audio/r1Admission'
import type { PlayOrder } from '../../../src/renderer/playback/playOrder'
import {
  DEFAULT_NORMALIZATION_POLICY,
  normalizationPolicyForMode
} from '../../../src/renderer/audio/normalization'
import { PlaybackScheduler } from '../../../src/renderer/playback/scheduler'
import type { RepeatMode } from '../../../src/renderer/playback/traversal'
import type { Track } from '../../../src/shared/library'

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: id,
    discNo: null,
    year: null,
    durationSec: 120,
    codec: 'flac',
    encodedBytes: 12_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

class FakeEngine implements AudioEngine {
  currentTime = 0
  duration = 120
  volume = 1
  normalizationPolicy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  decodePolicy: R1Policy = DEFAULT_R1_POLICY
  status: PlaybackStatus = 'idle'
  trackId: number | null = null
  transitionPolicy: AudioTransitionPolicy = 'sample-accurate'
  timeline = Symbol('fake-audio-context')
  startTime = 0
  scheduledStart: SampleAccurateTime | null = null
  scheduledFadeInSec = 0
  scheduledFadeOut: { at: SampleAccurateTime; durationSec: number } | null = null

  readonly loads: number[] = []
  readonly pending: Array<{
    trackId: number
    resolve: () => void
    reject: (error: AudioEngineError) => void
  }> = []
  playCount = 0
  pauseCount = 0
  scheduledCount = 0
  adoptedCount = 0
  cancelledCount = 0
  cancelledFadeCount = 0
  disposed = false
  manual = false

  readonly #listeners = new Map<string, Set<(payload: never) => void>>()

  async load(trackId: number): Promise<void> {
    this.loads.push(trackId)
    this.trackId = trackId
    this.status = 'loading'
    this.emit('statuschange', 'loading')
    if (!this.manual) {
      this.ready()
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.pending.push({
        trackId,
        resolve: () => {
          this.ready()
          resolve()
        },
        reject
      })
    })
  }

  settle(index = 0): void {
    const pending = this.pending[index]
    if (!pending) throw new Error(`No pending load ${index}`)
    pending.resolve()
  }

  fail(index = 0): void {
    const pending = this.pending[index]
    if (!pending) throw new Error(`No pending load ${index}`)
    const error = new AudioEngineError('decode-failed', 'Prefetch failed.', pending.trackId)
    this.status = 'idle'
    this.emit('error', error)
    pending.reject(error)
  }

  private ready(): void {
    this.status = 'ready'
    this.emit('statuschange', 'ready')
    this.emit('timeupdate', { currentTime: 0, duration: this.duration })
  }

  async play(): Promise<void> {
    this.playCount += 1
    this.status = 'playing'
    this.emit('statuschange', 'playing')
  }

  pause(): void {
    this.pauseCount += 1
    this.status = 'paused'
    this.emit('statuschange', 'paused')
  }

  seek(seconds: number): void {
    this.currentTime = seconds
    if (this.status === 'ended') this.status = 'paused'
    this.emit('timeupdate', { currentTime: seconds, duration: this.duration })
  }

  setVolume(gain: number): void {
    this.volume = gain
  }

  setNormalizationPolicy(policy: NormalizationPolicy): void {
    this.normalizationPolicy = policy
  }

  setDecodePolicy(policy: Partial<R1Policy>): void {
    this.decodePolicy = { ...this.decodePolicy, ...policy }
  }

  get sampleAccurateEndTime(): SampleAccurateTime | null {
    if (this.transitionPolicy !== 'sample-accurate' || this.status !== 'playing') return null
    return { timeline: this.timeline, timeSec: this.startTime + this.duration - this.currentTime }
  }

  scheduleSampleAccurateStart(at: SampleAccurateTime, fadeInDurationSec = 0): boolean {
    if (
      this.transitionPolicy !== 'sample-accurate' ||
      this.status === 'playing' ||
      at.timeline !== this.timeline
    ) {
      return false
    }
    this.scheduledStart = at
    this.scheduledFadeInSec = fadeInDurationSec
    this.scheduledCount += 1
    return true
  }

  scheduleSampleAccurateFadeOut(at: SampleAccurateTime, durationSec: number): boolean {
    if (
      this.transitionPolicy !== 'sample-accurate' ||
      this.status !== 'playing' ||
      at.timeline !== this.timeline
    ) {
      return false
    }
    this.scheduledFadeOut = { at, durationSec }
    return true
  }

  adoptScheduledStart(): boolean {
    if (!this.scheduledStart) return false
    this.scheduledStart = null
    this.adoptedCount += 1
    this.status = 'playing'
    this.emit('statuschange', 'playing')
    this.emit('timeupdate', { currentTime: 0, duration: this.duration })
    return true
  }

  cancelScheduledStart(): void {
    if (!this.scheduledStart) return
    this.scheduledStart = null
    this.scheduledFadeInSec = 0
    this.cancelledCount += 1
  }

  cancelScheduledFade(): void {
    if (!this.scheduledFadeOut) return
    this.scheduledFadeOut = null
    this.cancelledFadeCount += 1
  }

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void {
    const listeners = this.#listeners.get(type) ?? new Set()
    listeners.add(listener as (payload: never) => void)
    this.#listeners.set(type, listeners)
    return () => listeners.delete(listener as (payload: never) => void)
  }

  emit<K extends keyof AudioEngineEventMap>(type: K, payload: AudioEngineEventMap[K]): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      ;(listener as (value: AudioEngineEventMap[K]) => void)(payload)
    }
  }

  end(): void {
    if (this.trackId === null) return
    this.status = 'ended'
    this.emit('statuschange', 'ended')
    this.emit('ended', { trackId: this.trackId })
  }

  dispose(): void {
    this.disposed = true
    this.#listeners.clear()
  }
}

function harness(
  total = 6,
  crossfadeMs = 0,
  repeatMode: RepeatMode = 'off',
  prefetchDepth?: number
) {
  const engines = [new FakeEngine(), new FakeEngine()]
  const timeline = Symbol('shared-audio-context')
  for (const engine of engines) engine.timeline = timeline
  let engineIndex = 0
  const at = vi.fn(async (index: number) => (index >= 0 && index < total ? track(index) : null))
  const count = vi.fn(async () => total)
  const order: PlayOrder = { id: 'snapshot', at, count }
  const onCrossfadeAdjusted = vi.fn()
  const scheduler = new PlaybackScheduler({
    crossfadeMs,
    repeatMode,
    onCrossfadeAdjusted,
    ...(prefetchDepth === undefined ? {} : { prefetchDepth }),
    createEngine: () => {
      const engine = engines[engineIndex++]
      if (!engine) throw new Error('Scheduler created more than two engines')
      return engine
    }
  })
  return { scheduler, engines, order, at, count, onCrossfadeAdjusted }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('PlaybackScheduler', () => {
  it('prefetches exactly one successor after current playback is established', async () => {
    const h = harness()
    await h.scheduler.start(h.order, 1, track(1))
    await settle()

    expect(h.engines[0].loads).toEqual([1])
    expect(h.engines[1].loads).toEqual([2])
    expect(h.at).toHaveBeenCalledTimes(1)
    expect(h.at).toHaveBeenCalledWith(2)
    expect(h.scheduler.prefetchState).toMatchObject({
      status: 'ready',
      index: 2,
      trackId: 2,
      transitionPolicy: 'sample-accurate'
    })
    expect(h.engines[1].scheduledStart).toEqual({
      timeline: h.engines[0].timeline,
      timeSec: 120
    })
  })

  /**
   * `audio.prefetchDepth` at zero — the one advanced R1 key whose effect is
   * structural rather than numeric.
   *
   * Zero is not a smaller version of one. It removes the prepared engine that a
   * sample-accurate join needs, so what these assert is that the scheduler
   * degrades to loading the successor at the boundary rather than breaking: the
   * gapless join is what a depth of zero trades away, and playback is not.
   */
  describe('decode-ahead depth', () => {
    it('prepares nothing when the depth is zero', async () => {
      const h = harness(6, 0, 'off', 0)
      await h.scheduler.start(h.order, 1, track(1))
      await settle()

      expect(h.engines[0].loads).toEqual([1])
      expect(h.engines[1].loads).toEqual([])
      // Not even asked for: the successor lookup is a round trip, and a depth of
      // zero is a request not to make it.
      expect(h.at).not.toHaveBeenCalled()
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'idle', index: null })
    })

    it('leaves the prefetch idle rather than failed', async () => {
      // The natural-end handler reads `resolving` as "fail closed" and `idle` as
      // "nothing prepared". Nothing failed here, so it has to be the latter or a
      // boundary would surface an error the operator did not cause.
      const h = harness(6, 0, 'off', 0)
      await h.scheduler.start(h.order, 1, track(1))
      await settle()

      expect(h.scheduler.prefetchState.status).toBe('idle')
      expect(h.scheduler.prefetchState.error).toBeNull()
    })

    it('discards what is already prepared when the depth drops to zero', async () => {
      const h = harness()
      await h.scheduler.start(h.order, 1, track(1))
      await settle()
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready', index: 2 })

      h.scheduler.setPrefetchDepth(0)

      expect(h.scheduler.prefetchDepth).toBe(0)
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'idle', index: null })
    })

    it('prepares again at the next opportunity once the depth is restored', async () => {
      // Restored rather than immediate: starting a decode under a track the user
      // is in the middle of is not what turning a setting back on asked for.
      const h = harness(6, 0, 'off', 0)
      await h.scheduler.start(h.order, 1, track(1))
      await settle()
      expect(h.engines[1].loads).toEqual([])

      h.scheduler.setPrefetchDepth(1)
      expect(h.scheduler.prefetchState.status).toBe('idle')

      await h.scheduler.next()
      await settle()

      expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready' })
    })

    it('reads a nonsense depth as no decode-ahead', () => {
      const h = harness()
      h.scheduler.setPrefetchDepth(Number.NaN)

      expect(h.scheduler.prefetchDepth).toBe(0)
    })
  })

  describe('repeat', () => {
    it('costs no length query when it cannot wrap', async () => {
      // The boundary path runs on every track, so a count per track would be a
      // round trip per track for a mode that has no use for the answer.
      const h = harness(6, 0, 'off')
      await h.scheduler.start(h.order, 1, track(1))
      await settle()

      expect(h.count).not.toHaveBeenCalled()
    })

    it('stops at the last row with repeat off', async () => {
      const h = harness(3, 0, 'off')
      await h.scheduler.start(h.order, 2, track(2))
      await settle()

      expect(h.engines[1].loads).toEqual([])
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'idle', index: null })
    })

    it('prepares the first row at the last boundary under repeat-all', async () => {
      const h = harness(3, 0, 'all')
      await h.scheduler.start(h.order, 2, track(2))
      await settle()

      expect(h.at).toHaveBeenCalledWith(0)
      expect(h.engines[1].loads).toEqual([0])
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready', index: 0, trackId: 0 })
      // A wrap is a boundary like any other: prepared and scheduled, not a
      // reload after the fact.
      expect(h.engines[1].scheduledStart).not.toBeNull()
    })

    describe('repeat-one', () => {
      it('prepares the playing track again, as a real gapless boundary', async () => {
        const h = harness(6, 0, 'one')
        await h.scheduler.start(h.order, 1, track(1))
        await settle()

        expect(h.engines[1].loads).toEqual([1])
        expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready', index: 1, trackId: 1 })
        expect(h.engines[1].scheduledStart).toEqual({
          timeline: h.engines[0].timeline,
          timeSec: 120
        })
      })

      it('decodes twice however long it loops', async () => {
        // From the second lap the outgoing slot already holds this very track
        // at `ended`, and an ended decoded source can be scheduled again from
        // zero — so the loop ping-pongs between two slots. This is also why R1
        // accounts two copies of a repeating track rather than one.
        const h = harness(6, 0, 'one')
        const changes: number[] = []
        h.scheduler.on('trackchange', ({ track: next }) => changes.push(next.id))

        await h.scheduler.start(h.order, 1, track(1))
        await settle()
        h.engines[0].end()
        await settle()
        h.engines[1].end()
        await settle()

        expect(changes).toEqual([1, 1, 1])
        expect(h.engines[0].loads).toEqual([1])
        expect(h.engines[1].loads).toEqual([1])
      })

      it('moves on when Next is pressed', async () => {
        const h = harness(6, 0, 'one')
        await h.scheduler.start(h.order, 1, track(1))
        await settle()

        await expect(h.scheduler.next()).resolves.toMatchObject({ id: 2 })
      })
    })

    it('wraps both directions on an explicit press', async () => {
      const h = harness(3, 0, 'all')
      await h.scheduler.start(h.order, 0, track(0))
      await settle()

      await expect(h.scheduler.previous()).resolves.toMatchObject({ id: 2 })
      await expect(h.scheduler.next()).resolves.toMatchObject({ id: 0 })
    })

    it('re-decides a successor that has already been prepared', async () => {
      const h = harness(3, 0, 'off')
      await h.scheduler.start(h.order, 2, track(2))
      await settle()
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'idle' })

      h.scheduler.setRepeatMode('all')
      await settle()

      expect(h.engines[1].loads).toEqual([0])
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready', index: 0 })
    })

    it('keeps a ready boundary when the mode names the same successor', async () => {
      // Repeat-all differs from repeat-off only at the last row. Discarding a
      // decoded, scheduled successor everywhere else would turn a button press
      // into an audible risk for nothing.
      const h = harness(6, 0, 'off')
      await h.scheduler.start(h.order, 1, track(1))
      await settle()
      const cancelled = h.engines[1].cancelledCount

      h.scheduler.setRepeatMode('all')
      await settle()

      expect(h.engines[1].loads).toEqual([2])
      expect(h.engines[1].cancelledCount).toBe(cancelled)
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready', index: 2 })
    })

    it('reports the mode it is traversing under', () => {
      const h = harness()
      expect(h.scheduler.repeatMode).toBe('off')
      h.scheduler.setRepeatMode('one')
      expect(h.scheduler.repeatMode).toBe('one')
    })
  })

  describe('retarget', () => {
    it('swaps the order under the playing track without restarting it', async () => {
      // What turning shuffle on mid-album does: the audible row keeps playing
      // and simply acquires a new position in a new order.
      const h = harness()
      await h.scheduler.start(h.order, 1, track(1))
      await settle()
      expect(h.engines[1].loads).toEqual([2])

      const reversed: PlayOrder = {
        id: 'reversed',
        at: vi.fn(async (index: number) => track(10 + index)),
        count: vi.fn(async () => 6)
      }
      h.scheduler.retarget(reversed, 4)
      await settle()

      expect(h.engines[0].playCount).toBe(1)
      expect(h.engines[0].loads).toEqual([1])
      expect(reversed.at).toHaveBeenCalledWith(5)
      expect(h.scheduler.prefetchState).toMatchObject({ status: 'ready', index: 5, trackId: 15 })
    })

    it('republishes the playing track at its new position', async () => {
      const h = harness()
      const changes: Array<{ id: number; index: number }> = []
      h.scheduler.on('trackchange', ({ track: next, position }) =>
        changes.push({ id: next.id, index: position.index })
      )

      await h.scheduler.start(h.order, 1, track(1))
      await settle()
      h.scheduler.retarget(h.order, 0)
      await settle()

      expect(changes).toEqual([
        { id: 1, index: 1 },
        { id: 1, index: 0 }
      ])
    })

    it('strands a successor that was already decoding', async () => {
      const h = harness()
      h.engines[1].manual = true
      await h.scheduler.start(h.order, 1, track(1))
      await settle()
      expect(h.engines[1].loads).toEqual([2])

      h.scheduler.retarget(h.order, 3)
      await settle()
      // The decode of 2 is still parked. Releasing it must not let it claim a
      // prefetch slot that now belongs to a different position.
      h.engines[1].settle(0)
      await settle()

      expect(h.engines[1].loads).toEqual([2, 4])
      expect(h.scheduler.prefetchState).toMatchObject({ index: 4, trackId: 4 })
    })
  })

  it('promotes the scheduled decoded successor without loading or playing it again', async () => {
    const h = harness()
    const changes: number[] = []
    h.scheduler.on('trackchange', ({ track: next }) => changes.push(next.id))

    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    h.engines[0].end()
    await settle()

    expect(h.engines[1].loads).toEqual([1])
    expect(h.engines[1].playCount).toBe(0)
    expect(h.engines[1].adoptedCount).toBe(1)
    expect(changes).toEqual([0, 1])
    // Once 1 is audible the freed slot begins preparing 2.
    expect(h.engines[0].loads).toEqual([0, 2])

    // A stale callback from the freed slot cannot advance or adopt again.
    h.engines[0].emit('ended', { trackId: 0 })
    await settle()
    expect(changes).toEqual([0, 1])
    expect(h.engines[1].adoptedCount).toBe(1)
  })

  it('uses the exact current source endpoint on the shared timeline', async () => {
    const h = harness()
    h.engines[0].startTime = 17.25
    h.engines[0].duration = 2.5

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledStart?.timeline).toBe(h.engines[0].timeline)
    expect(h.engines[1].scheduledStart?.timeSec).toBe(19.75)
  })

  it('cancels and establishes a fresh decoded timeline across pause, resume and seek', async () => {
    const h = harness()
    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    expect(h.engines[1].scheduledCount).toBe(1)

    h.scheduler.pause()
    expect(h.engines[1].scheduledStart).toBeNull()
    expect(h.engines[1].cancelledCount).toBe(1)

    await h.scheduler.play()
    expect(h.engines[1].scheduledCount).toBe(2)

    h.scheduler.seek(30)
    expect(h.engines[1].cancelledCount).toBe(2)
    expect(h.engines[1].scheduledCount).toBe(3)
    expect(h.engines[1].scheduledStart?.timeSec).toBe(90)
  })

  it('cancels a planned boundary before a skip starts the prepared track now', async () => {
    const h = harness(6, 2500)
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    await h.scheduler.goTo(1)
    await settle()

    expect(h.engines[1].cancelledCount).toBe(1)
    expect(h.engines[0].cancelledFadeCount).toBe(1)
    expect(h.engines[1].playCount).toBe(1)
    expect(h.engines[1].adoptedCount).toBe(0)
    expect(h.scheduler.trackId).toBe(1)
  })

  it('classifies streaming-involved crossfade boundaries as hard and starts them on ended', async () => {
    const h = harness(6, 2500)
    h.engines[1].transitionPolicy = 'hard'

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.scheduler.prefetchState.transitionPolicy).toBe('hard')
    expect(h.engines[1].scheduledCount).toBe(0)

    h.engines[0].end()
    await settle()

    expect(h.engines[1].adoptedCount).toBe(0)
    expect(h.engines[1].playCount).toBe(1)
    expect(h.scheduler.transitionPolicy).toBe('hard')
  })

  it('does not schedule a decoded successor after a streaming current track', async () => {
    const h = harness(6, 2500)
    h.engines[0].transitionPolicy = 'hard'

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledCount).toBe(0)

    h.engines[0].end()
    await settle()

    expect(h.engines[1].adoptedCount).toBe(0)
    expect(h.engines[1].playCount).toBe(1)
  })

  it('selects only the equal-power overlap path for a non-zero duration', async () => {
    const h = harness(6, 2500)

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledCount).toBe(1)
    expect(h.engines[1].scheduledStart?.timeSec).toBe(117.5)
    expect(h.engines[1].scheduledFadeInSec).toBe(2.5)
    expect(h.engines[0].scheduledFadeOut).toEqual({
      at: h.engines[1].scheduledStart,
      durationSec: 2.5
    })
  })

  it('keeps zero duration exclusively on the exact gapless path', async () => {
    const h = harness()

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledStart?.timeSec).toBe(120)
    expect(h.engines[1].scheduledFadeInSec).toBe(0)
    expect(h.engines[0].scheduledFadeOut).toBeNull()
  })

  it.each([750, 5000])('plans a %ims overlap against the same endpoint', async (durationMs) => {
    const h = harness(6, durationMs)

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledStart?.timeSec).toBe(120 - durationMs / 1000)
    expect(h.engines[1].scheduledFadeInSec).toBe(durationMs / 1000)
    expect(h.engines[0].scheduledFadeOut?.durationSec).toBe(durationMs / 1000)
  })

  it('clamps short tracks to half the shorter side and records the reason', async () => {
    const h = harness(6, 10_000)
    h.engines[0].duration = 6
    h.engines[1].duration = 4

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledStart?.timeSec).toBe(4)
    expect(h.engines[1].scheduledFadeInSec).toBe(2)
    expect(h.onCrossfadeAdjusted).toHaveBeenCalledWith({
      requestedMs: 10_000,
      effectiveMs: 2000,
      reasons: ['current-track', 'next-track']
    })
  })

  it('degrades a late prefetch to the remaining schedulable time', async () => {
    const h = harness(6, 5000)
    h.engines[0].currentTime = 119

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledFadeInSec).toBeCloseTo(0.98)
    expect(h.onCrossfadeAdjusted).toHaveBeenCalledWith({
      requestedMs: 5000,
      effectiveMs: 980,
      reasons: ['late-prefetch']
    })
  })

  it('records a zero-duration hard degradation when prefetch misses the overlap', async () => {
    const h = harness(6, 5000)
    h.engines[0].currentTime = 120

    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    expect(h.engines[1].scheduledStart).toBeNull()
    expect(h.onCrossfadeAdjusted).toHaveBeenCalledWith({
      requestedMs: 5000,
      effectiveMs: 0,
      reasons: ['late-prefetch']
    })
  })

  it('cancels and rebuilds both sides when the duration changes', async () => {
    const h = harness()
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    h.scheduler.setCrossfadeMs(3000)
    expect(h.engines[1].cancelledCount).toBe(1)
    expect(h.engines[1].scheduledFadeInSec).toBe(3)
    expect(h.engines[0].scheduledFadeOut?.durationSec).toBe(3)

    h.scheduler.setCrossfadeMs(0)
    expect(h.engines[1].cancelledCount).toBe(2)
    expect(h.engines[0].cancelledFadeCount).toBe(1)
    expect(h.engines[1].scheduledFadeInSec).toBe(0)
    expect(h.engines[1].scheduledStart?.timeSec).toBe(120)
  })

  it('updates normalization on current and prefetched slots without rebuilding either', async () => {
    const h = harness()
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    h.scheduler.setNormalizationPolicy(normalizationPolicyForMode('album'))

    expect(h.engines.map((engine) => engine.normalizationPolicy.mode)).toEqual(['album', 'album'])
    expect(h.engines.map((engine) => engine.loads)).toEqual([[0], [1]])
  })

  it('cancels both overlap envelopes before pausing', async () => {
    const h = harness(6, 3000)
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    h.scheduler.pause()

    expect(h.engines[1].cancelledCount).toBe(1)
    expect(h.engines[0].cancelledFadeCount).toBe(1)
    expect(h.engines[0].pauseCount).toBe(1)
  })

  it('cancels and replans both overlap envelopes after a seek', async () => {
    const h = harness(6, 3000)
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    h.scheduler.seek(30)

    expect(h.engines[1].cancelledCount).toBe(1)
    expect(h.engines[0].cancelledFadeCount).toBe(1)
    expect(h.engines[1].scheduledStart?.timeSec).toBe(87)
    expect(h.engines[0].scheduledFadeOut?.durationSec).toBe(3)
  })

  it('keeps a failed prefetch isolated until the deterministic boundary error', async () => {
    const h = harness()
    h.engines[1].manual = true
    const errors: AudioEngineError[] = []
    h.scheduler.on('error', (error) => errors.push(error))

    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    h.engines[1].fail()
    await settle()

    expect(h.scheduler.status).toBe('playing')
    expect(h.scheduler.trackId).toBe(0)
    expect(h.scheduler.prefetchState.status).toBe('failed')
    expect(errors).toHaveLength(0)

    h.engines[0].end()
    await settle()
    expect(errors).toHaveLength(1)
    expect(errors[0].trackId).toBe(1)
    expect(h.engines[1].playCount).toBe(0)
  })

  it('reports a failed next-row lookup only when the boundary arrives', async () => {
    const h = harness()
    h.at.mockRejectedValueOnce(new Error('database unavailable'))
    const errors: AudioEngineError[] = []
    h.scheduler.on('error', (error) => errors.push(error))

    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    expect(h.scheduler.prefetchState.status).toBe('failed')
    expect(errors).toHaveLength(0)

    h.engines[0].end()
    await settle()
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('Could not resolve the prefetched track.')
  })

  it('does not start fetch/decode when a row lookup resolves after the boundary', async () => {
    const h = harness()
    let resolveNext!: (track: Track) => void
    h.at.mockImplementationOnce(
      () =>
        new Promise<Track>((resolve) => {
          resolveNext = resolve
        })
    )
    const errors: AudioEngineError[] = []
    h.scheduler.on('error', (error) => errors.push(error))

    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    expect(h.scheduler.prefetchState.status).toBe('resolving')

    h.engines[0].end()
    await settle()
    expect(errors[0].message).toBe('The next track was not prepared before the boundary.')

    resolveNext(track(1))
    await settle()
    expect(h.engines[1].loads).toHaveLength(0)
    expect(h.engines[1].playCount).toBe(0)
  })

  it('cannot promote a late prefetch after a newer skip chose another track', async () => {
    const h = harness()
    h.engines[1].manual = true

    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    expect(h.engines[1].loads).toEqual([1])

    const skip = h.scheduler.goTo(2)
    await settle()
    expect(h.engines[1].loads).toEqual([1, 2])

    // Complete the stale request first, then the intended request.
    h.engines[1].settle(0)
    await settle()
    expect(h.scheduler.trackId).toBe(2)
    expect(h.engines[1].playCount).toBe(0)

    h.engines[1].settle(1)
    await skip
    expect(h.scheduler.trackId).toBe(2)
    expect(h.engines[1].playCount).toBe(1)
  })

  it('a seek invalidates boundary promotion that was already waiting', async () => {
    const h = harness()
    h.engines[1].manual = true
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    h.engines[0].end()
    h.scheduler.seek(30)
    h.engines[1].settle()
    await settle()

    expect(h.scheduler.trackId).toBe(0)
    expect(h.engines[1].playCount).toBe(0)
  })

  it('stop disposes both owners and strands late work', async () => {
    const h = harness()
    h.engines[1].manual = true
    await h.scheduler.start(h.order, 0, track(0))
    await settle()

    h.scheduler.stop()
    h.engines[1].settle()
    await settle()

    expect(h.scheduler.status).toBe('idle')
    expect(h.scheduler.trackId).toBeNull()
    expect(h.scheduler.prefetchState.status).toBe('idle')
    expect(h.engines.every((engine) => engine.disposed)).toBe(true)
    expect(h.engines[1].playCount).toBe(0)
  })

  it('stop cancels an already planned decoded boundary', async () => {
    const h = harness(6, 2500)
    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    expect(h.engines[1].scheduledStart).not.toBeNull()

    h.scheduler.stop()

    expect(h.engines[1].cancelledCount).toBe(1)
    expect(h.engines[0].cancelledFadeCount).toBe(1)
  })
})
