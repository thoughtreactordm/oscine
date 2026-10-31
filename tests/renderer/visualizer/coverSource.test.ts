import { describe, expect, it, vi } from 'vitest'
import { artworkUrl } from '@shared/ipc'
import { SWATCH_COUNT, type CoverSlot } from '../../../src/renderer/visualizer/cover'
import {
  STAND_IN_REFRESH_SEC,
  createCoverSource
} from '../../../src/renderer/visualizer/coverSource'
import { createPaletteModel, PALETTE_PROPERTIES } from '../../../src/renderer/visualizer/palette'

const FRAME = 1 / 60

interface FakeSlot extends CoverSlot {
  readonly name: string
}

/** Every slot the source was ever handed, with its close count. */
function harness() {
  const made: { slot: FakeSlot; close: ReturnType<typeof vi.fn> }[] = []
  const make = (name: string, synthetic: boolean): FakeSlot => {
    const close = vi.fn()
    const slot: FakeSlot = {
      name,
      bitmap: { width: 640, height: 640, close },
      texture: null,
      aspect: 1,
      swatches: new Float32Array(SWATCH_COUNT * 3),
      synthetic
    }
    made.push({ slot, close })
    return slot
  }

  const pending = new Map<
    string,
    { resolve: (slot: FakeSlot) => void; reject: (error: unknown) => void; signal: AbortSignal }
  >()
  let standIns = 0
  const source = createCoverSource<FakeSlot>({
    decode: (url, signal) =>
      new Promise((resolve, reject) => pending.set(url, { resolve, reject, signal })),
    standIn: (pixels, edge, swatches) => {
      expect(pixels).toHaveLength(edge * edge * 4)
      expect(swatches).toHaveLength(SWATCH_COUNT * 3)
      return make(`stand-in ${++standIns}`, true)
    }
  })

  const model = createPaletteModel()
  model.setTarget(new Map(PALETTE_PROPERTIES.map((p) => [p, 'oklch(0.6 0.15 250)'])))

  const decoded = async (url: string, name: string): Promise<FakeSlot> => {
    const slot = make(name, false)
    pending.get(url)?.resolve(slot)
    await Promise.resolve()
    await Promise.resolve()
    return slot
  }
  const failed = async (url: string): Promise<void> => {
    pending.get(url)?.reject(new Error('decode failed'))
    await Promise.resolve()
    await Promise.resolve()
  }
  const frame = (dt = FRAME) => source.frame(model.palette, dt)
  const settle = () => {
    for (let i = 0; i < 90; i++) frame()
  }
  /** Every bitmap closed at most once, and every one not showing closed. */
  const assertLifecycle = () => {
    const input = frame(0)
    for (const { slot, close } of made) {
      const live = slot === input.current || slot === input.previous
      expect(close.mock.calls.length, slot.name).toBe(live ? 0 : 1)
    }
  }

  return { source, model, pending, made, decoded, failed, frame, settle, assertLifecycle }
}

const A = artworkUrl('aaaa', 'large')
const B = artworkUrl('bbbb', 'large')
const C = artworkUrl('cccc', 'large')
const NONE = artworkUrl(null, 'large')

describe('createCoverSource', () => {
  it('always hands out a cover: the stand-in until the first decode, then a fade into it', async () => {
    const h = harness()
    h.source.setArtwork(A)
    const first = h.frame()
    expect(first.current.synthetic).toBe(true)

    const a = await h.decoded(A, 'A')
    expect(h.frame()).toMatchObject({ current: a, previous: { synthetic: true } })
    h.settle()
    expect(h.frame()).toMatchObject({ current: a, previous: null, mix: 1 })
    h.assertLifecycle()
  })

  it('keeps the previous cover until the next one has decoded', async () => {
    const h = harness()
    h.source.setArtwork(A)
    h.frame()
    const a = await h.decoded(A, 'A')
    h.settle()

    h.source.setArtwork(B)
    h.settle()
    expect(h.frame()).toMatchObject({ current: a, previous: null })

    const b = await h.decoded(B, 'B')
    expect(h.frame()).toMatchObject({ current: b, previous: a })
    h.settle()
    h.assertLifecycle()
  })

  it('aborts and discards a decode that loses the race to the next track', async () => {
    const h = harness()
    h.source.setArtwork(A)
    h.frame()
    h.source.setArtwork(B)
    expect(h.pending.get(A)?.signal.aborted).toBe(true)

    const b = await h.decoded(B, 'B')
    const lateA = await h.decoded(A, 'late A')
    h.settle()
    expect(h.frame().current).toBe(b)
    expect(h.made.find((m) => m.slot === lateA)?.close).toHaveBeenCalledTimes(1)
    h.assertLifecycle()
  })

  it('A→B→C with C arriving mid-fade drops B', async () => {
    const h = harness()
    h.source.setArtwork(A)
    h.frame()
    const a = await h.decoded(A, 'A')
    h.settle()
    h.source.setArtwork(B)
    const b = await h.decoded(B, 'B')
    for (let i = 0; i < 10; i++) h.frame()
    h.source.setArtwork(C)
    const c = await h.decoded(C, 'C')
    expect(h.frame()).toMatchObject({ current: c, previous: a })
    expect(h.made.find((m) => m.slot === b)?.close).toHaveBeenCalledTimes(1)
    h.settle()
    h.assertLifecycle()
  })

  it('a rejected decode yields the synthetic stand-in', async () => {
    const h = harness()
    h.source.setArtwork(A)
    h.frame()
    const a = await h.decoded(A, 'A')
    h.settle()

    h.source.setArtwork(B)
    await h.failed(B)
    const input = h.frame()
    expect(input.current.synthetic).toBe(true)
    expect(input.previous).toBe(a)
    h.settle()
    expect(h.frame()).toMatchObject({ current: { synthetic: true }, previous: null })
    h.assertLifecycle()
  })

  it('missing artwork goes straight to the stand-in without a decode', () => {
    const h = harness()
    h.source.setArtwork(NONE)
    expect(h.pending.size).toBe(0)
    expect(h.frame().current.synthetic).toBe(true)
    h.source.setArtwork(null)
    h.settle()
    expect(h.frame().current.synthetic).toBe(true)
    h.assertLifecycle()
  })

  it('regenerates the stand-in as the palette moves, throttled, and once more when it settles', () => {
    const h = harness()
    h.source.setArtwork(NONE)
    const before = h.frame().current
    h.settle()
    expect(h.frame().current).toBe(before) // a still palette repaints nothing

    h.model.setTarget(new Map(PALETTE_PROPERTIES.map((p) => [p, 'oklch(0.5 0.2 30)'])))
    const seen = new Set<CoverSlot>()
    let frames = 0
    while (h.model.moving || frames < 20) {
      h.model.update(FRAME)
      const input = h.frame()
      expect(input.previous).toBeNull() // a repaint is a swap, not a fade
      seen.add(input.current)
      frames++
    }
    const lerp = frames * FRAME
    expect(seen.size).toBeGreaterThan(1)
    expect(seen.size).toBeLessThanOrEqual(Math.ceil(lerp / STAND_IN_REFRESH_SEC) + 2)

    // The last repaint can trail the palette's last step by one refresh interval.
    for (let i = 0; i < 10; i++) h.frame()
    const final = h.frame().current
    for (let i = 0; i < 30; i++) h.frame()
    expect(h.frame().current).toBe(final)
    h.assertLifecycle()
  })

  it('dispose aborts the decode and closes every bitmap once', async () => {
    const h = harness()
    h.source.setArtwork(A)
    h.frame()
    const a = await h.decoded(A, 'A')
    h.settle()
    h.source.setArtwork(B)
    h.source.dispose()
    expect(h.pending.get(B)?.signal.aborted).toBe(true)
    const late = await h.decoded(B, 'late B')
    for (const { slot, close } of h.made) expect(close, slot.name).toHaveBeenCalledTimes(1)
    expect(late).toBeDefined()
    expect(a).toBeDefined()
  })
})
