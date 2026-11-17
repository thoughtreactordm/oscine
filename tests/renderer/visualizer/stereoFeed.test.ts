import { describe, expect, it } from 'vitest'
import {
  createStereoFeed,
  stereoSupported,
  withStereoSupport,
  type StereoSource
} from '../../../src/renderer/visualizer/stereoFeed'

/**
 * W23-14: the host holds the stereo tap open exactly while a `needs.stereo`
 * effect is the instantiated one, so W23-13's lazy attach/detach happens.
 */

const PHASE = { id: 'phase', needs: { stereo: true } }
const BARS = { id: 'bars' }
const HALO = { id: 'halo', needs: { cover: true } }

function fakeSource(answer = true) {
  const log: string[] = []
  let open = 0
  const source: StereoSource & { readonly open: number } = {
    get open() {
      return open
    },
    subscribeStereoWaveform() {
      open++
      log.push('subscribe')
      let released = false
      return () => {
        if (released) return
        released = true
        open--
        log.push('release')
      }
    },
    readStereoWaveform(left, right) {
      log.push('read')
      if (!answer) return false
      left.fill(0.5)
      right.fill(-0.25)
      return true
    }
  }
  return { source, log }
}

describe('the stereo feed (W23-14)', () => {
  it('subscribes while Phase is instantiated and releases when it is replaced', () => {
    const { source, log } = fakeSource()
    const feed = createStereoFeed(source)

    feed.sync(BARS)
    expect(source.open).toBe(0)
    expect(feed.read()).toBeNull()

    feed.sync(PHASE)
    expect(source.open).toBe(1)
    expect(feed.subscribed).toBe(true)

    // The host disposes the outgoing instance, then creates the next one.
    feed.sync(null)
    expect(source.open).toBe(0)
    feed.sync(HALO)
    expect(source.open).toBe(0)
    expect(log.filter((entry) => entry !== 'read')).toEqual(['subscribe', 'release'])
  })

  it('holds one subscription across a re-create of the same effect', () => {
    const { source } = fakeSource()
    const feed = createStereoFeed(source)
    feed.sync(PHASE)
    feed.sync(PHASE)
    expect(source.open).toBe(1)
    feed.sync(null)
    feed.sync(PHASE)
    expect(source.open).toBe(1)
  })

  it('releases on dispose, and is reusable after', () => {
    const { source } = fakeSource()
    const feed = createStereoFeed(source)
    feed.sync(PHASE)
    feed.dispose()
    expect(source.open).toBe(0)
    expect(feed.read()).toBeNull()
    feed.dispose()
    expect(source.open).toBe(0)
    feed.sync(PHASE)
    expect(source.open).toBe(1)
  })

  it('reads into its own buffers and says when the read answered nothing', () => {
    const { source } = fakeSource(true)
    const feed = createStereoFeed(source)
    feed.sync(PHASE)
    const input = feed.read()
    expect(input?.live).toBe(true)
    expect(input?.left[0]).toBe(0.5)
    expect(input?.right[1023]).toBe(-0.25)
    expect(input?.left.length).toBe(1024)

    const quiet = fakeSource(false)
    const silent = createStereoFeed(quiet.source)
    silent.sync(PHASE)
    expect(silent.read()?.live).toBe(false)
  })

  it('never subscribes to a surface without the pair', () => {
    const feed = createStereoFeed({})
    feed.sync(PHASE)
    expect(feed.subscribed).toBe(false)
    expect(feed.read()).toBeNull()

    const half = createStereoFeed({ readStereoWaveform: () => true })
    half.sync(PHASE)
    expect(half.subscribed).toBe(false)
  })
})

describe('stereo availability (W23-14)', () => {
  it('needs both halves of the pair', () => {
    expect(stereoSupported(fakeSource().source)).toBe(true)
    expect(stereoSupported({ readStereoWaveform: () => true })).toBe(false)
    expect(stereoSupported({ subscribeStereoWaveform: () => () => {} })).toBe(false)
    expect(stereoSupported({})).toBe(false)
    expect(stereoSupported(null)).toBe(false)
  })

  it('drops stereo effects only when the engine lacks the tap', () => {
    const effects = [BARS, HALO, PHASE]
    expect(withStereoSupport(effects, true)).toBe(effects)
    expect(withStereoSupport(effects, false)).toEqual([BARS, HALO])
    const mono = [BARS, HALO]
    expect(withStereoSupport(mono, false)).toBe(mono)
  })
})
