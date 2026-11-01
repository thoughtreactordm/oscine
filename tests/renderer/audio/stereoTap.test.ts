import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WAVEFORM_SAMPLE_COUNT } from '../../../src/renderer/audio/AudioEngine'
import type { TrackAudioSource } from '../../../src/renderer/audio/AudioPath'
import { createBrowserStreamingPlatform } from '../../../src/renderer/audio/browserStreamingPlatform'
import { DecodedAudioEngine } from '../../../src/renderer/audio/DecodedAudioEngine'
import type { DecodedAudioContextLease } from '../../../src/renderer/audio/decodedAudioContext'
import { StereoTap } from '../../../src/renderer/audio/stereoTap'
import {
  StreamingAudioEngine,
  type StreamingMedia,
  type StreamingPlatform
} from '../../../src/renderer/audio/StreamingAudioEngine'

/**
 * Fake audio nodes in the `EqAudioNode` style: real edges, so a test can ask
 * what is wired to what, and `disconnect(node)` drops one edge while
 * `disconnect()` drops them all — the distinction the tap's detach relies on.
 */
class FakeNode {
  readonly edges: Array<{ to: FakeNode; output: number }> = []
  connect(to: FakeNode, output = 0): FakeNode {
    this.edges.push({ to, output })
    return to
  }
  disconnect(to?: FakeNode): void {
    if (!to) {
      this.edges.length = 0
      return
    }
    const index = this.edges.findIndex((edge) => edge.to === to)
    // Real Web Audio throws when asked to drop an edge that does not exist.
    if (index < 0) throw new Error('InvalidAccessError: not connected')
    this.edges.splice(index, 1)
  }
  feeds(to: FakeNode): boolean {
    return this.edges.some((edge) => edge.to === to)
  }
}

class FakeGain extends FakeNode {
  readonly gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn()
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048
  /** What this analyser "hears": it fills every read with this level. */
  level = 0
  readonly getFloatTimeDomainData = vi.fn((into: Float32Array) => {
    into.fill(this.level)
  })
}

class FakeSplitter extends FakeNode {
  channelInterpretation = 'discrete'
  constructor(readonly outputs: number) {
    super()
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null
  onended: (() => void) | null = null
  start = vi.fn()
  stop = vi.fn()
}

/** Every node a context creates, so a test can assert on what exists. */
class FakeContext {
  state = 'running'
  currentTime = 5
  sampleRate = 48_000
  readonly destination = new FakeNode()
  readonly gains: FakeGain[] = []
  readonly analysers: FakeAnalyser[] = []
  readonly splitters: FakeSplitter[] = []
  readonly mediaSources: FakeNode[] = []
  buffer = { duration: 10, length: 480_000, numberOfChannels: 2, sampleRate: 48_000 }

  createGain(): FakeGain {
    const node = new FakeGain()
    this.gains.push(node)
    return node
  }
  createAnalyser(): FakeAnalyser {
    const node = new FakeAnalyser()
    this.analysers.push(node)
    return node
  }
  createChannelSplitter(outputs = 6): FakeSplitter {
    const node = new FakeSplitter(outputs)
    this.splitters.push(node)
    return node
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource()
  }
  createMediaElementSource(): FakeNode {
    const node = new FakeNode()
    this.mediaSources.push(node)
    return node
  }
  decodeAudioData = async (): Promise<unknown> => this.buffer
  close = vi.fn(async () => {})
  resume = vi.fn(async () => {})

  /** The splitter and two analysers of a live stereo tap, if one is attached. */
  liveTap(): { splitter: FakeSplitter; left: FakeAnalyser; right: FakeAnalyser } | null {
    const splitter = this.splitters.at(-1)
    if (!splitter || splitter.edges.length === 0) return null
    const left = splitter.edges.find((edge) => edge.output === 0)?.to as FakeAnalyser
    const right = splitter.edges.find((edge) => edge.output === 1)?.to as FakeAnalyser
    return { splitter, left, right }
  }
}

function lease(context: FakeContext): DecodedAudioContextLease<AudioContext> {
  return {
    context: context as unknown as AudioContext,
    destination: context.destination as unknown as AudioNode,
    timeline: Symbol('shared-context'),
    release: vi.fn()
  }
}

function buffers(fill = 9): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  return [
    new Float32Array(WAVEFORM_SAMPLE_COUNT).fill(fill),
    new Float32Array(WAVEFORM_SAMPLE_COUNT).fill(fill)
  ]
}

function source(overrides: Partial<TrackAudioSource> = {}): TrackAudioSource {
  return {
    trackId: 7,
    url: 'oscine://track/7',
    durationSec: 10,
    encodedBytes: 4,
    channels: 2,
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null,
    ...overrides
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('StereoTap', () => {
  it('builds nothing until the first subscription and removes it all on the last', () => {
    const context = new FakeContext()
    const tap = new StereoTap(context)
    const gain = new FakeGain()
    const onward = new FakeNode()
    gain.connect(onward)
    tap.setSource(gain)

    expect(context.splitters).toHaveLength(0)
    expect(context.analysers).toHaveLength(0)
    expect(gain.edges).toHaveLength(1)

    const first = tap.subscribe()
    const second = tap.subscribe()
    expect(context.splitters).toHaveLength(1)
    expect(context.analysers).toHaveLength(2)
    const live = context.liveTap()!
    expect(gain.feeds(live.splitter)).toBe(true)
    expect(live.left.fftSize).toBe(WAVEFORM_SAMPLE_COUNT)
    expect(live.right.fftSize).toBe(WAVEFORM_SAMPLE_COUNT)
    // Leaves: nothing new reaches anywhere.
    expect(live.left.edges).toHaveLength(0)
    expect(live.right.edges).toHaveLength(0)

    first()
    first()
    expect(tap.attached).toBe(true)
    second()
    expect(tap.attached).toBe(false)
    // Only the splitter edge went; the route onward survives.
    expect(gain.edges.map((edge) => edge.to)).toEqual([onward])
    expect(live.splitter.edges).toHaveLength(0)
  })

  it('up-mixes by speaker rules, so a mono input reaches both channels', () => {
    const context = new FakeContext()
    const tap = new StereoTap(context)
    tap.subscribe()
    expect(context.splitters[0].outputs).toBe(2)
    expect(context.splitters[0].channelInterpretation).toBe('speakers')
  })

  it('wires a source set while attached, and one set before the first subscription', () => {
    const context = new FakeContext()
    const tap = new StereoTap(context)
    const early = new FakeGain()
    tap.setSource(early)
    const release = tap.subscribe()
    expect(early.feeds(context.liveTap()!.splitter)).toBe(true)

    const later = new FakeGain()
    tap.setSource(later)
    expect(later.feeds(context.liveTap()!.splitter)).toBe(true)
    release()
    expect(later.edges).toHaveLength(0)
  })

  it('reads false with both buffers untouched while detached', () => {
    const tap = new StereoTap(new FakeContext())
    const [left, right] = buffers()
    expect(tap.read(left, right)).toBe(false)
    expect(left.every((sample) => sample === 9)).toBe(true)
    expect(right.every((sample) => sample === 9)).toBe(true)
  })

  it('reads each channel from its own analyser, or copies left when mono', () => {
    const context = new FakeContext()
    const tap = new StereoTap(context)
    tap.subscribe()
    const live = context.liveTap()!
    live.left.level = 0.25
    live.right.level = -0.5
    const [left, right] = buffers()

    expect(tap.read(left, right)).toBe(true)
    expect(left[0]).toBeCloseTo(0.25)
    expect(right[0]).toBeCloseTo(-0.5)

    expect(tap.read(left, right, true)).toBe(true)
    expect(Array.from(right)).toEqual(Array.from(left))
  })

  it('survives a release after the source was disconnected wholesale', () => {
    const context = new FakeContext()
    const tap = new StereoTap(context)
    const gain = new FakeGain()
    tap.setSource(gain)
    const release = tap.subscribe()
    gain.disconnect()
    expect(() => release()).not.toThrow()
  })
})

describe('DecodedAudioEngine stereo tap', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(4)))
    )
  })

  async function playing(channels = 2) {
    const context = new FakeContext()
    context.buffer.numberOfChannels = channels
    const engine = new DecodedAudioEngine(undefined, lease(context))
    await engine.load(source({ channels }))
    await engine.play()
    // Construction: master gain first, then each source's transition and
    // normalization gains (see `#startSource`).
    const transition = context.gains[1]
    return { context, engine, transition }
  }

  it('has no splitter and no extra analysers with zero subscribers', async () => {
    const { context, engine } = await playing()
    expect(context.splitters).toHaveLength(0)
    // The mono waveform analyser and nothing else.
    expect(context.analysers).toHaveLength(1)
    const [left, right] = buffers()
    expect(engine.readStereoWaveform(left, right)).toBe(false)
    expect(left[0]).toBe(9)
    expect(right[0]).toBe(9)
    engine.dispose()
  })

  it('attaches at the transition gain on the first subscription and detaches on the last', async () => {
    const { context, engine, transition } = await playing()
    const master = context.gains[0]

    const first = engine.subscribeStereoWaveform()
    const second = engine.subscribeStereoWaveform()
    expect(context.splitters).toHaveLength(1)
    const live = context.liveTap()!
    expect(transition.feeds(live.splitter)).toBe(true)
    // Ahead of master volume, like the mono tap.
    expect(master.feeds(live.splitter)).toBe(false)

    live.left.level = 0.3
    live.right.level = -0.3
    const [left, right] = buffers()
    expect(engine.readStereoWaveform(left, right)).toBe(true)
    expect(left[0]).toBeCloseTo(0.3)
    expect(right[0]).toBeCloseTo(-0.3)

    first()
    expect(context.liveTap()).not.toBeNull()
    second()
    expect(context.liveTap()).toBeNull()
    expect(transition.feeds(live.splitter)).toBe(false)
    // The track still reaches the master gain.
    expect(transition.feeds(master)).toBe(true)
    engine.dispose()
  })

  it('follows a seek onto the new source while subscribed', async () => {
    const { context, engine } = await playing()
    engine.subscribeStereoWaveform()
    engine.seek(3)
    const fresh = context.gains.at(-2)!
    expect(fresh.feeds(context.liveTap()!.splitter)).toBe(true)
    engine.dispose()
    expect(context.liveTap()).toBeNull()
  })

  it('fills both buffers identically from a mono source', async () => {
    const { context, engine } = await playing(1)
    engine.subscribeStereoWaveform()
    const live = context.liveTap()!
    live.left.level = 0.6
    live.right.level = 0
    const [left, right] = buffers()
    expect(engine.readStereoWaveform(left, right)).toBe(true)
    expect(right[0]).toBeCloseTo(0.6)
    expect(Array.from(right)).toEqual(Array.from(left))
    engine.dispose()
  })

  it('reads false and leaves both buffers untouched once paused', async () => {
    const { engine } = await playing()
    engine.subscribeStereoWaveform()
    engine.pause()
    const [left, right] = buffers()
    expect(engine.readStereoWaveform(left, right)).toBe(false)
    expect(left.every((sample) => sample === 9)).toBe(true)
    expect(right.every((sample) => sample === 9)).toBe(true)
    engine.dispose()
  })
})

class FakeAudio {
  preload = ''
  crossOrigin: string | null = null
  pause = vi.fn()
  load = vi.fn()
  removeAttribute = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

describe('browserStreamingPlatform stereo tap', () => {
  beforeEach(() => {
    vi.stubGlobal('Audio', FakeAudio)
  })

  function platform() {
    const context = new FakeContext()
    const created = createBrowserStreamingPlatform(lease(context))
    const normalization = context.mediaSources[0].edges[0].to as FakeGain
    return { context, created, normalization }
  }

  it('has no splitter with zero subscribers', () => {
    const { context } = platform()
    expect(context.splitters).toHaveLength(0)
    expect(context.analysers).toHaveLength(1)
  })

  it('attaches at normalization on the first subscription and detaches on the last', () => {
    const { context, created, normalization } = platform()
    const first = created.subscribeStereoWaveform!()
    const second = created.subscribeStereoWaveform!()
    expect(context.splitters).toHaveLength(1)
    const live = context.liveTap()!
    expect(normalization.feeds(live.splitter)).toBe(true)

    live.left.level = 0.2
    live.right.level = 0.4
    const [left, right] = buffers()
    expect(created.readStereoWaveform!(left, right)).toBe(true)
    expect(left[0]).toBeCloseTo(0.2)
    expect(right[0]).toBeCloseTo(0.4)

    first()
    second()
    expect(context.liveTap()).toBeNull()
    expect(normalization.feeds(live.splitter)).toBe(false)
    // Normalization still reaches master volume and the mono analyser.
    expect(normalization.edges).toHaveLength(2)

    const [l2, r2] = buffers()
    expect(created.readStereoWaveform!(l2, r2)).toBe(false)
    expect(l2[0]).toBe(9)
    created.dispose()
  })
})

class FakeMedia implements StreamingMedia {
  currentTime = 0
  duration = 120
  ended = false
  readyState = 1
  errorCode: number | null = null
  setSource(): void {}
  clearSource(): void {}
  load(): void {}
  async play(): Promise<void> {}
  pause(): void {}
  on(): () => void {
    return () => {}
  }
}

describe('StreamingAudioEngine stereo tap', () => {
  function engineWith(platform: Partial<StreamingPlatform>) {
    const full: StreamingPlatform = {
      media: new FakeMedia(),
      contextState: 'running',
      resumeContext: async () => {},
      setOutputVolume: () => {},
      setNormalizationGain: () => {},
      dispose: () => {},
      ...platform
    }
    return new StreamingAudioEngine(full)
  }

  it('reads only while playing, leaving both buffers untouched otherwise', async () => {
    const read = vi.fn((left: Float32Array, right: Float32Array) => {
      left.fill(0.1)
      right.fill(0.2)
      return true
    })
    const engine = engineWith({ readStereoWaveform: read })
    const [left, right] = buffers()

    expect(engine.readStereoWaveform(left, right)).toBe(false)
    await engine.load(source())
    expect(engine.readStereoWaveform(left, right)).toBe(false)
    expect(left[0]).toBe(9)
    expect(right[0]).toBe(9)
    expect(read).not.toHaveBeenCalled()

    await engine.play()
    expect(engine.readStereoWaveform(left, right)).toBe(true)
    expect(left[0]).toBeCloseTo(0.1)
    expect(right[0]).toBeCloseTo(0.2)
    engine.dispose()
  })

  it('degrades to silence on a platform with no stereo tap', async () => {
    const engine = engineWith({})
    const release = engine.subscribeStereoWaveform()
    await engine.load(source())
    await engine.play()
    const [left, right] = buffers()
    expect(engine.readStereoWaveform(left, right)).toBe(false)
    expect(() => release()).not.toThrow()
    engine.dispose()
  })

  it('forwards subscriptions to the platform', () => {
    const release = vi.fn()
    const subscribe = vi.fn(() => release)
    const engine = engineWith({ subscribeStereoWaveform: subscribe })
    engine.subscribeStereoWaveform()()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
