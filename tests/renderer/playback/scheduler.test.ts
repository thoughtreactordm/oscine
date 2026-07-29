import { describe, expect, it, vi } from 'vitest'
import {
  AudioEngineError,
  type AudioEngine,
  type AudioEngineEventMap,
  type PlaybackStatus
} from '../../../src/renderer/audio/AudioEngine'
import type { PlayOrder } from '../../../src/renderer/playback/playOrder'
import { PlaybackScheduler } from '../../../src/renderer/playback/scheduler'
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
    bitDepth: 16
  }
}

class FakeEngine implements AudioEngine {
  currentTime = 0
  duration = 120
  volume = 1
  status: PlaybackStatus = 'idle'
  trackId: number | null = null
  transitionPolicy = 'sample-accurate' as const

  readonly loads: number[] = []
  readonly pending: Array<{
    trackId: number
    resolve: () => void
    reject: (error: AudioEngineError) => void
  }> = []
  playCount = 0
  pauseCount = 0
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

function harness(total = 6) {
  const engines = [new FakeEngine(), new FakeEngine()]
  let engineIndex = 0
  const at = vi.fn(async (index: number) => (index >= 0 && index < total ? track(index) : null))
  const order: PlayOrder = { id: 'snapshot', at }
  const scheduler = new PlaybackScheduler({
    createEngine: () => {
      const engine = engines[engineIndex++]
      if (!engine) throw new Error('Scheduler created more than two engines')
      return engine
    }
  })
  return { scheduler, engines, order, at }
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
  })

  it('promotes the decoded successor without loading it again at natural end', async () => {
    const h = harness()
    const changes: number[] = []
    h.scheduler.on('trackchange', ({ track: next }) => changes.push(next.id))

    await h.scheduler.start(h.order, 0, track(0))
    await settle()
    h.engines[0].end()
    await settle()

    expect(h.engines[1].loads).toEqual([1])
    expect(h.engines[1].playCount).toBe(1)
    expect(changes).toEqual([0, 1])
    // Once 1 is audible the freed slot begins preparing 2.
    expect(h.engines[0].loads).toEqual([0, 2])
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
})
