import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'
import {
  createPresenceEmitter,
  PRESENCE_SEEK_TOLERANCE_MS,
  type PresenceEmitter
} from '../../../src/renderer/playback/presenceEmitter'
import type { PresenceSignal } from '../../../src/shared/presence'
import type { PlaybackStatus } from '../../../src/renderer/audio/AudioEngine'
import type { Track } from '../../../src/shared/library'

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 1,
    rootId: 1,
    title: 'So What',
    artist: 'Miles Davis',
    album: 'Kind of Blue',
    albumArtist: 'Miles Davis',
    trackNo: 1,
    discNo: null,
    year: 1959,
    durationSec: 545,
    codec: 'flac',
    encodedBytes: 40_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    favorite: false,
    modified: false,
    artwork: { small: 'oscine://artwork/missing/small', large: 'oscine://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

/** A hand-fired interval clock, so heartbeats fire on demand rather than on time. */
class FakeTimers {
  private readonly handlers = new Map<number, () => void>()
  private nextId = 1
  now = 0

  readonly setInterval = (handler: () => void): ReturnType<typeof setInterval> => {
    const id = this.nextId++
    this.handlers.set(id, handler)
    return id as unknown as ReturnType<typeof setInterval>
  }

  readonly clearInterval = (handle: ReturnType<typeof setInterval>): void => {
    this.handlers.delete(handle as unknown as number)
  }

  /** One heartbeat tick: fire every live interval once. */
  fire(): void {
    for (const handler of [...this.handlers.values()]) handler()
  }

  get liveCount(): number {
    return this.handlers.size
  }
}

describe('presence emitter (W20-1)', () => {
  let status: Ref<PlaybackStatus>
  let nowPlaying: Ref<Track | null>
  let currentTime: Ref<number>
  let duration: Ref<number>
  let timers: FakeTimers
  let emitted: PresenceSignal[]
  let enabled: boolean
  let emitter: PresenceEmitter

  function build(): PresenceEmitter {
    return createPresenceEmitter({
      status,
      nowPlaying,
      currentTime,
      duration,
      enabled: () => enabled,
      emit: (signal) => emitted.push(signal),
      now: () => timers.now,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    })
  }

  /** Advance wall time and the playback clock together, then flush the watcher. */
  async function tick(deltaWallMs: number, currentTimeSec: number): Promise<void> {
    timers.now += deltaWallMs
    currentTime.value = currentTimeSec
    await nextTick()
  }

  beforeEach(() => {
    status = ref<PlaybackStatus>('idle')
    nowPlaying = ref<Track | null>(null)
    currentTime = ref<number>(0)
    duration = ref<number>(0)
    timers = new FakeTimers()
    emitted = []
    enabled = true
  })

  async function startPlaying(t: Track = track()): Promise<void> {
    nowPlaying.value = t
    status.value = 'playing'
    currentTime.value = 0
    await nextTick()
  }

  it('emits once on play, with the full signal', async () => {
    emitter = build()
    await startPlaying()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      track: {
        title: 'So What',
        artist: 'Miles Davis',
        album: 'Kind of Blue',
        albumArtist: 'Miles Davis',
        durationMs: 545_000
      },
      positionMs: 0,
      paused: false,
      playing: true
    })
    emitter.dispose()
  })

  it('does not emit on steady position ticks between heartbeats', async () => {
    emitter = build()
    await startPlaying()
    emitted.length = 0
    // Five 250 ms timeupdate ticks, each advancing exactly as the clock predicts.
    for (let i = 1; i <= 5; i++) await tick(250, i * 0.25)
    expect(emitted).toHaveLength(0)
    emitter.dispose()
  })

  it('emits immediately on pause and on resume', async () => {
    emitter = build()
    await startPlaying()
    emitted.length = 0

    status.value = 'paused'
    await nextTick()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ paused: true, playing: true })

    status.value = 'playing'
    await nextTick()
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ paused: false, playing: true })
    emitter.dispose()
  })

  it('emits on a track change', async () => {
    emitter = build()
    await startPlaying()
    emitted.length = 0
    nowPlaying.value = track({ id: 2, title: 'Freddie Freeloader', durationSec: 586 })
    currentTime.value = 0
    await tick(500, 0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].track).toMatchObject({ title: 'Freddie Freeloader', durationMs: 586_000 })
    emitter.dispose()
  })

  it('emits on a forward seek and on a backward seek', async () => {
    emitter = build()
    await startPlaying()
    // Reach ~5 s honestly.
    for (let i = 1; i <= 20; i++) await tick(250, i * 0.25)
    emitted.length = 0

    // Forward jump: wall advanced one tick, but position leapt 60 s.
    await tick(250, 65)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ positionMs: 65_000 })

    // Backward jump.
    await tick(250, 5)
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ positionMs: 5_000 })
    emitter.dispose()
  })

  it('treats movement within tolerance as steady, not a seek', async () => {
    emitter = build()
    await startPlaying()
    emitted.length = 0
    // Wall advanced 250 ms; position moved 250 ms plus jitter under the tolerance.
    await tick(250, (250 + PRESENCE_SEEK_TOLERANCE_MS - 1) / 1000)
    expect(emitted).toHaveLength(0)
    emitter.dispose()
  })

  it('fires a heartbeat on a long unpaused track and stops it when stopped', async () => {
    emitter = build()
    await startPlaying()
    emitted.length = 0
    expect(timers.liveCount).toBe(1)

    currentTime.value = 30
    timers.fire()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ positionMs: 30_000, playing: true })

    currentTime.value = 45
    timers.fire()
    expect(emitted).toHaveLength(2)

    // Stop: the clear signal, and the heartbeat is torn down.
    status.value = 'idle'
    nowPlaying.value = null
    await nextTick()
    expect(emitted.at(-1)).toEqual({ track: null, positionMs: 0, paused: false, playing: false })
    expect(timers.liveCount).toBe(0)

    const afterStop = emitted.length
    timers.fire()
    expect(emitted).toHaveLength(afterStop)
    emitter.dispose()
  })

  it('does not run a heartbeat while paused', async () => {
    emitter = build()
    await startPlaying()
    status.value = 'paused'
    await nextTick()
    expect(timers.liveCount).toBe(0)
    emitter.dispose()
  })

  it('emits nothing at all while disabled', async () => {
    enabled = false
    emitter = build()
    await startPlaying()
    status.value = 'paused'
    await nextTick()
    nowPlaying.value = track({ id: 9 })
    await tick(250, 0)
    await tick(250, 100)
    timers.fire()
    expect(emitted).toHaveLength(0)
    emitter.dispose()
  })

  it('stops emitting after dispose', async () => {
    emitter = build()
    await startPlaying()
    emitted.length = 0
    emitter.dispose()
    status.value = 'paused'
    await nextTick()
    timers.fire()
    expect(emitted).toHaveLength(0)
  })
})
