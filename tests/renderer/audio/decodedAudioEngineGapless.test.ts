import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecodedAudioEngine } from '../../../src/renderer/audio/DecodedAudioEngine'
import type { TrackAudioSource } from '../../../src/renderer/audio/AudioPath'
import type { DecodedAudioContextLease } from '../../../src/renderer/audio/decodedAudioContext'

class FakeSource {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  starts: Array<[number | undefined, number | undefined]> = []
  stopCount = 0
  disconnectCount = 0

  connect(): void {}

  start(when?: number, offset?: number): void {
    this.starts.push([when, offset])
  }

  stop(): void {
    this.stopCount += 1
  }

  disconnect(): void {
    this.disconnectCount += 1
  }
}

function source(overrides: Partial<TrackAudioSource> = {}): TrackAudioSource {
  return {
    trackId: 7,
    url: 'fermata://track/7',
    durationSec: 0.01,
    encodedBytes: 4,
    channels: 1,
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

function harness(options: { duration?: number; sampleRate?: number } = {}) {
  const timeline = Symbol('shared-context')
  const sources: FakeSource[] = []
  const duration = options.duration ?? 0.01
  const sampleRate = options.sampleRate ?? 48_000
  const buffer = {
    duration,
    length: Math.round(duration * sampleRate),
    numberOfChannels: 1,
    sampleRate
  } as AudioBuffer
  const gains: Array<{
    value: number
    cancelScheduledValues: ReturnType<typeof vi.fn>
    cancelAndHoldAtTime: ReturnType<typeof vi.fn>
    setValueAtTime: ReturnType<typeof vi.fn>
    linearRampToValueAtTime: ReturnType<typeof vi.fn>
    setValueCurveAtTime: ReturnType<typeof vi.fn>
  }> = []
  const gainNodes: Array<{
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }> = []
  const createGain = () => {
    const gain = {
      value: 1,
      cancelScheduledValues: vi.fn(),
      cancelAndHoldAtTime: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn()
    }
    gains.push(gain)
    const node = {
      gain,
      connect: vi.fn(),
      disconnect: vi.fn()
    }
    gainNodes.push(node)
    return node
  }
  const context = {
    currentTime: 5,
    sampleRate,
    state: 'running',
    destination: {},
    createGain,
    createBufferSource: () => {
      const created = new FakeSource()
      sources.push(created)
      return created
    },
    decodeAudioData: async () => buffer,
    close: vi.fn(async () => {})
  }
  const release = vi.fn()
  const lease: DecodedAudioContextLease<AudioContext> = {
    context: context as unknown as AudioContext,
    timeline,
    release
  }
  const engine = new DecodedAudioEngine(undefined, lease)
  return { engine, context, timeline, sources, gains, gainNodes, release }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DecodedAudioEngine gapless planning', () => {
  it('keeps the exact context-clock point through suspension and adopts without rebuilding', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness()
    await h.engine.load(source())
    h.context.state = 'suspended'

    expect(h.engine.scheduleSampleAccurateStart({ timeline: h.timeline, timeSec: 6 })).toBe(true)
    expect(h.sources).toHaveLength(1)
    expect(h.sources[0].starts).toEqual([[6, 0]])
    expect(h.engine.status).toBe('ready')

    expect(h.engine.adoptScheduledStart()).toBe(true)
    expect(h.sources).toHaveLength(1)
    expect(h.engine.status).toBe('playing')

    h.engine.dispose()
  })

  it('rejects another context timeline and cleanly rebuilds after cancellation', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness()
    await h.engine.load(source())

    expect(h.engine.scheduleSampleAccurateStart({ timeline: Symbol('other'), timeSec: 6 })).toBe(
      false
    )
    expect(h.sources).toHaveLength(0)

    h.engine.scheduleSampleAccurateStart({ timeline: h.timeline, timeSec: 6 })
    h.engine.cancelScheduledStart()
    expect(h.sources[0].stopCount).toBe(1)
    expect(h.sources[0].disconnectCount).toBe(1)
    expect(h.gainNodes[1].disconnect).toHaveBeenCalledTimes(1)

    await h.engine.play()
    expect(h.sources).toHaveLength(2)
    expect(h.sources[1].starts).toEqual([[5, 0]])

    h.engine.dispose()
  })

  it('derives a fresh endpoint after seek from context time, duration and offset', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness()
    await h.engine.load(source())
    await h.engine.play()
    expect(h.engine.sampleAccurateEndTime).toEqual({
      timeline: h.timeline,
      timeSec: 5.01
    })

    h.context.currentTime = 5.003
    h.engine.seek(0.004)
    expect(h.engine.sampleAccurateEndTime).toEqual({
      timeline: h.timeline,
      timeSec: 5.009
    })

    h.engine.dispose()
  })
})

describe('DecodedAudioEngine equal-power graph', () => {
  it.each([44_100, 48_000])(
    'places complementary curves at exact context times at %i Hz',
    async (sampleRate) => {
      vi.spyOn(console, 'info').mockImplementation(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new ArrayBuffer(4)))
      )
      const outgoing = harness({ duration: 10, sampleRate })
      const incoming = harness({ duration: 10, sampleRate })
      await outgoing.engine.load(source())
      await incoming.engine.load(source())
      await outgoing.engine.play()

      const start = { timeline: outgoing.timeline, timeSec: 12 }
      expect(outgoing.engine.scheduleSampleAccurateFadeOut(start, 3)).toBe(true)
      expect(
        incoming.engine.scheduleSampleAccurateStart({ timeline: incoming.timeline, timeSec: 12 }, 3)
      ).toBe(true)

      const outgoingCurveCall = outgoing.gains[1].setValueCurveAtTime.mock.calls[0]
      const incomingCurveCall = incoming.gains[1].setValueCurveAtTime.mock.calls[0]
      expect(outgoingCurveCall.slice(1)).toEqual([12, 3])
      expect(incomingCurveCall.slice(1)).toEqual([12, 3])

      const outgoingCurve = outgoingCurveCall[0] as Float32Array
      const incomingCurve = incomingCurveCall[0] as Float32Array
      const midpoint = Math.floor(outgoingCurve.length / 2)
      expect(outgoingCurve[0]).toBeCloseTo(1)
      expect(incomingCurve[0]).toBeCloseTo(0)
      expect(outgoingCurve[midpoint]).toBeCloseTo(Math.SQRT1_2, 6)
      expect(incomingCurve[midpoint]).toBeCloseTo(Math.SQRT1_2, 6)
      expect(outgoingCurve[midpoint] ** 2 + incomingCurve[midpoint] ** 2).toBeCloseTo(1, 6)
      expect(outgoingCurve.at(-1)).toBeCloseTo(0)
      expect(incomingCurve.at(-1)).toBeCloseTo(1)

      outgoing.engine.dispose()
      incoming.engine.dispose()
    }
  )

  it('keeps master-volume automation separate and restores a cancelled fade smoothly', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness({ duration: 10 })
    await h.engine.load(source())
    await h.engine.play()
    h.engine.scheduleSampleAccurateFadeOut({ timeline: h.timeline, timeSec: 12 }, 3)

    h.engine.setVolume(0.4)
    expect(h.gains[0].linearRampToValueAtTime).toHaveBeenCalledWith(0.4, 5.015)
    expect(h.gains[1].setValueCurveAtTime).toHaveBeenCalledTimes(1)

    h.context.currentTime = 12.5
    h.engine.cancelScheduledFade()
    expect(h.gains[1].cancelAndHoldAtTime).toHaveBeenCalledWith(12.5)
    expect(h.gains[1].linearRampToValueAtTime).toHaveBeenCalledWith(1, 12.515)

    h.engine.dispose()
  })

  it('keeps normalization automation separate from transition fades and master volume', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness({ duration: 10 })
    await h.engine.load(source({ rgTrackGainDb: -6, rgTrackPeak: 0.9, rgSource: 'tag' }))
    await h.engine.play()
    h.engine.scheduleSampleAccurateFadeOut({ timeline: h.timeline, timeSec: 12 }, 3)
    h.engine.setVolume(0.4)

    // Node order is master, then this source's transition and normalization.
    expect(h.gains[2].value).toBeCloseTo(0.501187)
    h.engine.setNormalizationMode('off')
    expect(h.gains[2].linearRampToValueAtTime).toHaveBeenCalledWith(1, 5.05)
    expect(h.gains[1].setValueCurveAtTime).toHaveBeenCalledTimes(1)
    expect(h.gains[0].linearRampToValueAtTime).toHaveBeenCalledWith(0.4, 5.015)

    h.engine.dispose()
  })

  it('releases every cancelled scheduled source and its transition stage', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness({ duration: 10 })
    await h.engine.load(source())

    h.engine.scheduleSampleAccurateStart({ timeline: h.timeline, timeSec: 6 }, 1)
    h.engine.cancelScheduledStart()
    h.engine.scheduleSampleAccurateStart({ timeline: h.timeline, timeSec: 7 }, 2)
    h.engine.cancelScheduledStart()

    expect(h.sources).toHaveLength(2)
    expect(h.sources.every((created) => created.stopCount === 1)).toBe(true)
    expect(h.sources.every((created) => created.disconnectCount === 1)).toBe(true)
    expect(h.gainNodes.slice(1).every((node) => node.disconnect.mock.calls.length === 1)).toBe(true)

    h.engine.dispose()
  })

  it('ramps an already-started scheduled source out before releasing it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
    const h = harness({ duration: 10 })
    await h.engine.load(source())
    h.engine.scheduleSampleAccurateStart({ timeline: h.timeline, timeSec: 6 }, 3)
    h.context.currentTime = 6.5

    h.engine.cancelScheduledStart()

    expect(h.gains[1].cancelAndHoldAtTime).toHaveBeenCalledWith(6.5)
    expect(h.gains[1].linearRampToValueAtTime).toHaveBeenCalledWith(0, 6.515)
    expect(h.sources[0].stopCount).toBe(1)
    expect(h.sources[0].disconnectCount).toBe(0)
    h.sources[0].onended?.()
    expect(h.sources[0].disconnectCount).toBe(1)
    expect(h.gainNodes[1].disconnect).toHaveBeenCalledTimes(1)

    h.engine.dispose()
  })
})
