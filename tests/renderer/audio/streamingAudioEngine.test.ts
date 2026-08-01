import { describe, expect, it, vi } from 'vitest'
import {
  StreamingAudioEngine,
  type StreamingMedia,
  type StreamingPlatform
} from '../../../src/renderer/audio/StreamingAudioEngine'
import type { TrackAudioSource } from '../../../src/renderer/audio/AudioPath'
import { normalizationPolicyForMode } from '../../../src/renderer/audio/normalization'

class FakeMedia implements StreamingMedia {
  currentTime = 0
  duration = 120
  ended = false
  readyState = 0
  errorCode: number | null = null
  source: string | null = null
  playCount = 0
  pauseCount = 0
  autoMetadata = true

  readonly listeners = new Map<string, Set<() => void>>()

  setSource(url: string): void {
    this.source = url
  }

  clearSource(): void {
    this.source = null
    this.readyState = 0
  }

  load(): void {
    if (this.source && this.autoMetadata) {
      queueMicrotask(() => {
        this.readyState = 1
        this.emit('loadedmetadata')
      })
    }
  }

  async play(): Promise<void> {
    this.playCount += 1
  }

  pause(): void {
    this.pauseCount += 1
  }

  on(type: string, listener: () => void): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    return () => set.delete(listener)
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

function source(overrides: Partial<TrackAudioSource> = {}): TrackAudioSource {
  return {
    trackId: 4,
    url: 'fermata://track/4',
    durationSec: 120,
    encodedBytes: 10_000_000,
    channels: 2,
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

function harness() {
  const media = new FakeMedia()
  const volumes: number[] = []
  const normalizations: Array<{ gain: number; ramp: boolean }> = []
  let contextState = 'suspended'
  const platform: StreamingPlatform = {
    media,
    get contextState() {
      return contextState
    },
    async resumeContext() {
      contextState = 'running'
    },
    setOutputVolume: (gain) => volumes.push(gain),
    setNormalizationGain: (gain, ramp) => normalizations.push({ gain, ramp }),
    dispose: vi.fn()
  }
  const engine = new StreamingAudioEngine(platform)
  return { engine, media, platform, volumes, normalizations }
}

describe('StreamingAudioEngine', () => {
  it('loads metadata without fetching the whole file and preserves transport semantics', async () => {
    const { engine, media, volumes, normalizations } = harness()
    const statuses: string[] = []
    const times: Array<{ currentTime: number; duration: number }> = []
    engine.on('statuschange', (status) => statuses.push(status))
    engine.on('timeupdate', (position) => times.push(position))

    await engine.load(source({ rgTrackGainDb: -6, rgTrackPeak: 0.9, rgSource: 'tag' }))
    expect(media.source).toBe('fermata://track/4')
    expect(engine.status).toBe('ready')
    expect(engine.duration).toBe(120)
    expect(normalizations[0]).toEqual({
      gain: expect.closeTo(0.501187, 5),
      ramp: false
    })

    engine.setVolume(0.35)
    engine.setNormalizationPolicy(normalizationPolicyForMode('off'))
    await engine.play()
    expect(media.playCount).toBe(1)
    expect(engine.status).toBe('playing')
    expect(volumes.at(-1)).toBe(0.35)
    expect(normalizations.at(-1)).toEqual({ gain: 1, ramp: true })

    engine.seek(42)
    expect(media.currentTime).toBe(42)
    engine.pause()
    expect(engine.status).toBe('paused')

    expect(statuses).toEqual(['loading', 'ready', 'playing', 'paused'])
    expect(times.at(-1)).toEqual({ currentTime: 42, duration: 120 })
  })

  it('emits the unchanged natural-end event and restarts after the end', async () => {
    const { engine, media } = harness()
    const ended = vi.fn()
    engine.on('ended', ended)
    await engine.load(source())
    await engine.play()

    media.currentTime = 120
    media.ended = true
    media.emit('ended')

    expect(engine.status).toBe('ended')
    expect(ended).toHaveBeenCalledWith({ trackId: 4 })

    await engine.play()
    expect(media.currentTime).toBe(0)
    expect(engine.status).toBe('playing')
  })

  it('maps media decode failures to the public error contract', async () => {
    const { engine, media } = harness()
    media.autoMetadata = false
    media.errorCode = 4
    const errors = vi.fn()
    engine.on('error', errors)

    const loading = engine.load(source())
    media.emit('error')

    await expect(loading).rejects.toMatchObject({ code: 'decode-failed', trackId: 4 })
    expect(errors).toHaveBeenCalledTimes(1)
    expect(engine.status).toBe('idle')
  })

  it('rejects a superseded metadata load quietly and leaves the newer track ready', async () => {
    const { engine, media } = harness()
    media.autoMetadata = false
    const errors = vi.fn()
    engine.on('error', errors)

    const first = engine.load(source())
    const second = engine.load(source({ trackId: 5, url: 'fermata://track/5' }))
    media.readyState = 1
    media.emit('loadedmetadata')

    await expect(first).rejects.toMatchObject({ code: 'aborted', trackId: 4 })
    await expect(second).resolves.toBeUndefined()
    expect(engine.trackId).toBe(5)
    expect(engine.status).toBe('ready')
    expect(errors).not.toHaveBeenCalled()
  })
})
