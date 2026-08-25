import { describe, expect, it, vi } from 'vitest'
import {
  AudioEngineError,
  WAVEFORM_SAMPLE_COUNT,
  type AudioEngineEventMap,
  type NormalizationPolicy,
  type PlaybackStatus,
  type SampleAccurateTime
} from '../../../src/renderer/audio/AudioEngine'
import type {
  AudioPath,
  DecodedAudioPath,
  TrackAudioSource
} from '../../../src/renderer/audio/AudioPath'
import {
  GuardedAudioEngine,
  type TrackNormalizationDiagnostic
} from '../../../src/renderer/audio/GuardedAudioEngine'
import {
  R1ReservationLedger,
  type R1AdmissionDecision
} from '../../../src/renderer/audio/r1Admission'
import {
  DEFAULT_NORMALIZATION_POLICY,
  normalizationPolicyForMode
} from '../../../src/renderer/audio/normalization'

const MIB = 1024 ** 2

class FakePath implements AudioPath {
  currentTime = 0
  duration = 0
  volume = 1
  normalizationPolicy: NormalizationPolicy = DEFAULT_NORMALIZATION_POLICY
  status: PlaybackStatus = 'idle'
  trackId: number | null = null
  readonly loads: TrackAudioSource[] = []
  unloadCount = 0
  playCount = 0
  manual = false
  issuedOnSettle = 0
  sampleAccurateEndTime: SampleAccurateTime | null = null
  scheduledStarts: SampleAccurateTime[] = []
  scheduleAccepted = false
  adoptAccepted = false
  cancelScheduledCount = 0
  /** What this path claims to be sounding, for the waveform tap. */
  waveformLevel: number | null = null

  readonly listeners = new Map<string, Set<(payload: never) => void>>()
  readonly pending: Array<{ source: TrackAudioSource; resolve: () => void }> = []

  load(source: TrackAudioSource): Promise<void> {
    this.loads.push(source)
    this.trackId = source.trackId
    this.status = 'loading'
    this.emit('statuschange', 'loading')
    if (!this.manual) {
      this.ready(source)
      return Promise.resolve()
    }
    return new Promise((resolve) => this.pending.push({ source, resolve }))
  }

  settle(index: number): void {
    const pending = this.pending[index]
    if (!pending) throw new Error(`No pending load ${index}`)
    this.ready(pending.source)
    pending.resolve()
  }

  private ready(source: TrackAudioSource): void {
    this.trackId = source.trackId
    this.duration = source.durationSec ?? 0
    this.status = 'ready'
    this.emit('statuschange', 'ready')
    this.emit('timeupdate', { currentTime: 0, duration: this.duration })
  }

  unload(): void {
    this.unloadCount += 1
    this.trackId = null
    this.status = 'idle'
    this.emit('statuschange', 'idle')
  }

  async play(): Promise<void> {
    this.playCount += 1
    this.status = 'playing'
    this.emit('statuschange', 'playing')
  }

  pause(): void {
    this.status = 'paused'
    this.emit('statuschange', 'paused')
  }

  seek(seconds: number): void {
    this.currentTime = seconds
    this.emit('timeupdate', { currentTime: seconds, duration: this.duration })
  }

  setVolume(gain: number): void {
    this.volume = gain
  }

  setNormalizationPolicy(policy: NormalizationPolicy): void {
    this.normalizationPolicy = policy
  }

  scheduleSampleAccurateStart(at: SampleAccurateTime, _fadeInDurationSec = 0): boolean {
    this.scheduledStarts.push(at)
    return this.scheduleAccepted
  }

  scheduleSampleAccurateFadeOut(at: SampleAccurateTime, _durationSec: number): boolean {
    this.scheduledStarts.push(at)
    return this.scheduleAccepted
  }

  adoptScheduledStart(): boolean {
    return this.adoptAccepted
  }

  cancelScheduledStart(): void {
    this.cancelScheduledCount += 1
  }

  cancelScheduledFade(): void {}

  readWaveform(into: Float32Array): boolean {
    if (this.waveformLevel === null) return false
    into.fill(this.waveformLevel)
    return true
  }

  on<K extends keyof AudioEngineEventMap>(
    type: K,
    listener: (payload: AudioEngineEventMap[K]) => void
  ): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener as (payload: never) => void)
    this.listeners.set(type, set)
    return () => set.delete(listener as (payload: never) => void)
  }

  emit<K extends keyof AudioEngineEventMap>(type: K, payload: AudioEngineEventMap[K]): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      ;(listener as (value: AudioEngineEventMap[K]) => void)(payload)
    }
  }

  dispose(): void {}
}

class FakeDecodedPath extends FakePath implements DecodedAudioPath {
  targetSampleRateHz = 48_000
  issuedNotFreedBytes = 0

  override settle(index: number): void {
    this.issuedNotFreedBytes += this.issuedOnSettle
    super.settle(index)
  }
}

function track(trackId: number, overrides: Partial<TrackAudioSource> = {}): TrackAudioSource {
  return {
    trackId,
    url: `oscine://track/${trackId}`,
    durationSec: 60,
    encodedBytes: 5 * MIB,
    channels: 2,
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

function harness(sources: Map<number, TrackAudioSource>) {
  const decoded = new FakeDecodedPath()
  const streaming = new FakePath()
  const decisions: R1AdmissionDecision[] = []
  const normalizationDecisions: TrackNormalizationDiagnostic[] = []
  const resolver = vi.fn(async (trackId: number) => {
    const found = sources.get(trackId)
    if (!found) throw new Error('not found')
    return found
  })
  const engine = new GuardedAudioEngine({
    decoded,
    createStreaming: () => streaming,
    resolveTrack: resolver,
    diagnostic: (decision) => decisions.push(decision),
    normalizationDiagnostic: (decision) => normalizationDecisions.push(decision)
  })
  return { engine, decoded, streaming, decisions, normalizationDecisions, resolver }
}

describe('GuardedAudioEngine', () => {
  it('reserves in-flight decode cost across current and prefetch engines', async () => {
    const reservations = new R1ReservationLedger()
    const firstDecoded = new FakeDecodedPath()
    const secondDecoded = new FakeDecodedPath()
    const firstStreaming = new FakePath()
    const secondStreaming = new FakePath()
    firstDecoded.manual = true
    const resolveTrack = async (trackId: number): Promise<TrackAudioSource> => track(trackId)
    const policy = { maxDecodedResidencyBytes: 70 * MIB }
    const first = new GuardedAudioEngine({
      decoded: firstDecoded,
      createStreaming: () => firstStreaming,
      resolveTrack,
      policy,
      reservations,
      diagnostic: () => {}
    })
    const second = new GuardedAudioEngine({
      decoded: secondDecoded,
      createStreaming: () => secondStreaming,
      resolveTrack,
      policy,
      reservations,
      diagnostic: () => {}
    })

    const current = first.load(1)
    await Promise.resolve()
    expect(reservations.reservedBytes).toBeGreaterThan(0)

    await second.load(2)
    expect(secondDecoded.loads).toHaveLength(0)
    expect(secondStreaming.loads.map((source) => source.trackId)).toEqual([2])

    firstDecoded.settle(0)
    await current
    expect(reservations.reservedBytes).toBe(0)

    await second.load(3)
    expect(secondDecoded.loads.map((source) => source.trackId)).toEqual([3])
  })

  it('keeps ordinary tracks on whole-buffer decode', async () => {
    const h = harness(new Map([[1, track(1)]]))

    await h.engine.load(1)
    await h.engine.play()

    expect(h.decoded.loads.map((source) => source.trackId)).toEqual([1])
    expect(h.streaming.loads).toHaveLength(0)
    expect(h.decisions[0]).toMatchObject({ path: 'decoded', reason: 'within-budget' })
    expect(h.engine.transitionPolicy).toBe('sample-accurate')
    expect(h.engine.status).toBe('playing')
  })

  it('applies tag and computed values identically while retaining source in diagnostics', async () => {
    const h = harness(
      new Map([
        [
          1,
          track(1, {
            rgTrackGainDb: 6,
            rgTrackPeak: 0.8,
            rgSource: 'tag'
          })
        ],
        [
          2,
          track(2, {
            rgTrackGainDb: 6,
            rgTrackPeak: 0.8,
            rgSource: 'computed'
          })
        ]
      ])
    )

    await h.engine.load(1)
    await h.engine.load(2)

    expect(h.normalizationDecisions).toEqual([
      expect.objectContaining({
        trackId: 1,
        mode: 'track',
        field: 'track',
        source: 'tag',
        gainDb: 6,
        peak: 0.8,
        effectiveGain: 1.25
      }),
      expect.objectContaining({
        trackId: 2,
        mode: 'track',
        field: 'track',
        source: 'computed',
        gainDb: 6,
        peak: 0.8,
        effectiveGain: 1.25
      })
    ])
    expect(h.decoded.normalizationPolicy.mode).toBe('track')

    h.engine.setNormalizationPolicy(normalizationPolicyForMode('off'))
    expect(h.decoded.normalizationPolicy.mode).toBe('off')
    expect(h.normalizationDecisions.at(-1)).toMatchObject({
      trackId: 2,
      mode: 'off',
      field: null,
      effectiveGain: 1
    })
  })

  it('forwards sample-accurate planning only to the admitted decoded path', async () => {
    const h = harness(new Map([[1, track(1)]]))
    const timeline = Symbol('shared')
    const boundary = { timeline, timeSec: 61 }
    h.decoded.sampleAccurateEndTime = boundary
    h.decoded.scheduleAccepted = true
    h.decoded.adoptAccepted = true

    await h.engine.load(1)

    expect(h.engine.sampleAccurateEndTime).toBe(boundary)
    expect(h.engine.scheduleSampleAccurateStart(boundary, 2.5)).toBe(true)
    expect(h.engine.scheduleSampleAccurateFadeOut(boundary, 2.5)).toBe(true)
    expect(h.engine.adoptScheduledStart()).toBe(true)
    h.engine.cancelScheduledStart()
    expect(h.decoded.scheduledStarts).toEqual([boundary, boundary])
    expect(h.decoded.cancelScheduledCount).toBe(1)
    expect(h.streaming.scheduledStarts).toHaveLength(0)
  })

  it('selects streaming before path load for cap, budget and unknown-metadata cases', async () => {
    const h = harness(
      new Map([
        [1, track(1, { durationSec: 20 * 60 })],
        [2, track(2, { durationSec: null })],
        [3, track(3)]
      ])
    )

    await h.engine.load(1)
    await h.engine.load(2)
    h.decoded.issuedNotFreedBytes = 599 * MIB
    await h.engine.load(3)

    expect(h.decoded.loads).toHaveLength(0)
    expect(h.streaming.loads.map((source) => source.trackId)).toEqual([1, 2, 3])
    expect(h.decisions.map((decision) => decision.reason)).toEqual([
      'per-track-cap',
      'unpriceable',
      'residency-budget'
    ])
    expect(h.decisions.every((decision) => decision.transitionPolicy === 'hard')).toBe(true)
    expect(h.engine.transitionPolicy).toBe('hard')
    expect(h.engine.sampleAccurateEndTime).toBeNull()
    expect(h.engine.scheduleSampleAccurateStart({ timeline: Symbol('other'), timeSec: 1 })).toBe(
      false
    )
    expect(h.streaming.scheduledStarts).toHaveLength(0)
  })

  it('reads the waveform from whichever path won admission', async () => {
    const h = harness(
      new Map([
        [1, track(1)],
        [2, track(2, { durationSec: 20 * 60 })]
      ])
    )
    h.decoded.waveformLevel = 0.25
    h.streaming.waveformLevel = 0.75
    const into = new Float32Array(WAVEFORM_SAMPLE_COUNT)

    // Nothing admitted yet: there is no active path to read from.
    expect(h.engine.readWaveform(into)).toBe(false)

    await h.engine.load(1)
    expect(h.engine.readWaveform(into)).toBe(true)
    expect(into[0]).toBeCloseTo(0.25)

    // The long track falls to streaming, and the tap has to follow it there.
    // A visualization wired to the decoded context alone would go flat here.
    await h.engine.load(2)
    expect(h.engine.readWaveform(into)).toBe(true)
    expect(into[0]).toBeCloseTo(0.75)

    // A path with no signal reports so rather than leaving stale samples.
    h.streaming.waveformLevel = null
    expect(h.engine.readWaveform(into)).toBe(false)
  })

  it('does not ask either path to load until metadata resolution completes', async () => {
    let release!: (source: TrackAudioSource) => void
    const pending = new Promise<TrackAudioSource>((resolve) => {
      release = resolve
    })
    const decoded = new FakeDecodedPath()
    const streaming = new FakePath()
    const engine = new GuardedAudioEngine({
      decoded,
      createStreaming: () => streaming,
      resolveTrack: () => pending,
      diagnostic: () => {}
    })

    const loading = engine.load(9)
    expect(engine.status).toBe('loading')
    expect(decoded.loads).toHaveLength(0)
    expect(streaming.loads).toHaveLength(0)

    release(track(9))
    await loading
    expect(decoded.loads).toHaveLength(1)
  })

  it('accounts a late superseded decode and never lets its events replace streaming state', async () => {
    const h = harness(
      new Map([
        [1, track(1)],
        [2, track(2, { durationSec: 20 * 60 })],
        [3, track(3)]
      ])
    )
    h.decoded.manual = true
    h.decoded.issuedOnSettle = 580 * MIB
    const first = h.engine.load(1)
    await Promise.resolve()
    expect(h.decoded.loads).toHaveLength(1)

    await h.engine.load(2)
    expect(h.engine.trackId).toBe(2)
    expect(h.engine.status).toBe('ready')

    h.decoded.settle(0)
    await expect(first).rejects.toBeInstanceOf(AudioEngineError)
    expect(h.engine.trackId).toBe(2)
    expect(h.engine.status).toBe('ready')

    await h.engine.load(3)
    expect(h.decisions.at(-1)?.reason).toBe('residency-budget')
    expect(h.streaming.loads.map((source) => source.trackId)).toEqual([2, 3])
  })

  it('makes a slower metadata lookup abort without touching the newer path', async () => {
    let releaseFirst!: (source: TrackAudioSource) => void
    const firstSource = new Promise<TrackAudioSource>((resolve) => {
      releaseFirst = resolve
    })
    const decoded = new FakeDecodedPath()
    const streaming = new FakePath()
    const engine = new GuardedAudioEngine({
      decoded,
      createStreaming: () => streaming,
      resolveTrack: (id) => (id === 1 ? firstSource : Promise.resolve(track(id))),
      diagnostic: () => {}
    })

    const first = engine.load(1)
    await engine.load(2)
    releaseFirst(track(1))

    await expect(first).rejects.toMatchObject({ code: 'aborted', trackId: 1 })
    expect(decoded.loads.map((source) => source.trackId)).toEqual([2])
    expect(engine.trackId).toBe(2)
  })
})
