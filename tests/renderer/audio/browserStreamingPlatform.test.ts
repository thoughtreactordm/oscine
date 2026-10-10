import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserStreamingPlatform } from '../../../src/renderer/audio/browserStreamingPlatform'
import {
  DecodedAudioContextPool,
  type DecodedAudioContextLease
} from '../../../src/renderer/audio/decodedAudioContext'

class FakeNode {
  readonly edges: FakeNode[] = []
  connect(destination: FakeNode): FakeNode {
    this.edges.push(destination)
    return destination
  }
  disconnect(): void {
    this.edges.length = 0
  }
}

class FakeGain extends FakeNode {
  readonly gain = {
    value: 1,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn()
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048
  getFloatTimeDomainData = vi.fn()
}

class FakeContext {
  state = 'running'
  currentTime = 0
  readonly destination = new FakeNode()
  readonly sources: Array<{ element: unknown; node: FakeNode }> = []
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })
  readonly resume = vi.fn(async () => {})
  createGain(): FakeGain {
    return new FakeGain()
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser()
  }
  createMediaElementSource(element: unknown): FakeNode {
    const node = new FakeNode()
    this.sources.push({ element, node })
    return node
  }
}

class FakeAudio {
  preload = ''
  crossOrigin: string | null = null
  pause = vi.fn()
  load = vi.fn()
  removeAttribute = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

function asLease(
  lease: DecodedAudioContextLease<FakeContext>
): DecodedAudioContextLease<AudioContext> {
  return lease as unknown as DecodedAudioContextLease<AudioContext>
}

describe('createBrowserStreamingPlatform', () => {
  const constructed = vi.fn()

  beforeEach(() => {
    constructed.mockClear()
    vi.stubGlobal('Audio', FakeAudio)
    // Every context opens its own OS output stream. The platform must never
    // build one; reaching this constructor is the regression.
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          constructed()
        }
      }
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('captures its element on the leased context and feeds the lease destination', () => {
    const context = new FakeContext()
    const eqInput = new FakeNode()
    const pool = new DecodedAudioContextPool(
      () => context,
      () => eqInput as unknown as AudioNode
    )

    createBrowserStreamingPlatform(asLease(pool.acquire()))

    expect(constructed).not.toHaveBeenCalled()
    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].element).toBeInstanceOf(FakeAudio)
    // source → normalization → master → the EQ input the pool resolved.
    const normalization = context.sources[0].node.edges[0]
    const master = normalization.edges.find((node) => !(node instanceof FakeAnalyser))
    expect(master?.edges).toEqual([eqInput])
    expect(context.destination.edges).toEqual([])
  })

  it('shares the decoded slots’ context and leaves it open while they hold it', () => {
    const context = new FakeContext()
    const createContext = vi.fn(() => context)
    const pool = new DecodedAudioContextPool(createContext)
    const decoded = pool.acquire()

    const platform = createBrowserStreamingPlatform(asLease(pool.acquire()))
    expect(createContext).toHaveBeenCalledTimes(1)
    expect(platform.contextState).toBe('running')

    platform.dispose()
    expect(context.close).not.toHaveBeenCalled()

    decoded.release()
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('keeps the context alive for a stream that outlives the decoded slots', () => {
    const context = new FakeContext()
    const pool = new DecodedAudioContextPool(() => context)
    const decoded = pool.acquire()
    const platform = createBrowserStreamingPlatform(asLease(pool.acquire()))

    decoded.release()
    expect(context.close).not.toHaveBeenCalled()

    platform.dispose()
    expect(context.close).toHaveBeenCalledTimes(1)
  })
})
