import { describe, expect, it, vi } from 'vitest'
import type { PlayOrder } from '../../../src/renderer/playback/playOrder'
import { createShuffledPlayOrder } from '../../../src/renderer/playback/shufflePlayOrder'
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
    playCount: 0,
    lastPlayedAt: null,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** A linear order of `total` rows whose track ids are their own positions. */
function base(total: number | null, id = 'list:title:asc'): PlayOrder {
  return {
    id,
    at: vi.fn(async (index: number) =>
      total !== null && index >= 0 && index < total ? track(index) : null
    ),
    count: vi.fn(async () => total)
  }
}

/** Every base position the shuffled order names, in order. */
async function walk(order: PlayOrder, length: number): Promise<Array<number | null>> {
  const seen: Array<number | null> = []
  for (let i = 0; i < length; i += 1) seen.push((await order.at(i))?.id ?? null)
  return seen
}

describe('createShuffledPlayOrder', () => {
  it('is a permutation: every row exactly once, then nothing', async () => {
    // The property that makes shuffle worth doing this way. A random successor
    // would repeat rows before the order was exhausted.
    const order = createShuffledPlayOrder(base(50), { seed: 7 })
    const walked = await walk(order, 50)

    expect(new Set(walked).size).toBe(50)
    expect([...walked].sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 50 }, (_, i) => i)
    )
    await expect(order.at(50)).resolves.toBeNull()
  })

  it('does not simply hand back the base order', async () => {
    const order = createShuffledPlayOrder(base(50), { seed: 7 })
    expect(await walk(order, 50)).not.toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  it('traverses the same sequence for the same seed, and a different one otherwise', async () => {
    const seven = await walk(createShuffledPlayOrder(base(30), { seed: 7 }), 30)
    const alsoSeven = await walk(createShuffledPlayOrder(base(30), { seed: 7 }), 30)
    const eight = await walk(createShuffledPlayOrder(base(30), { seed: 8 }), 30)

    expect(alsoSeven).toEqual(seven)
    expect(eight).not.toEqual(seven)
  })

  describe('the pinned row', () => {
    it('plays first, so enabling shuffle never interrupts', async () => {
      const order = createShuffledPlayOrder(base(50), { seed: 3, pinnedBaseIndex: 41 })
      await expect(order.at(0)).resolves.toMatchObject({ id: 41 })
    })

    it('resolves without waiting for the length', async () => {
      // What keeps the click path free of an extra round trip: position 0 is
      // known before the permutation can be built.
      const source = base(50)
      const order = createShuffledPlayOrder(source, { seed: 3, pinnedBaseIndex: 41 })

      await expect(order.at(0)).resolves.toMatchObject({ id: 41 })

      expect(source.count).not.toHaveBeenCalled()
      expect(source.at).toHaveBeenCalledExactlyOnceWith(41)
    })

    it('leaves the result a permutation', async () => {
      const order = createShuffledPlayOrder(base(50), { seed: 3, pinnedBaseIndex: 41 })
      expect(new Set(await walk(order, 50)).size).toBe(50)
    })

    it('is ignored when it is not a row', async () => {
      const order = createShuffledPlayOrder(base(10), { seed: 3, pinnedBaseIndex: 99 })
      expect(new Set(await walk(order, 10)).size).toBe(10)
    })
  })

  it('recovers the base position for turning shuffle off', async () => {
    const order = createShuffledPlayOrder(base(20), { seed: 11 })

    for (let i = 0; i < 20; i += 1) {
      await expect(order.baseIndexAt(i)).resolves.toBe((await order.at(i))?.id)
    }
    await expect(order.baseIndexAt(20)).resolves.toBeNull()
    await expect(order.baseIndexAt(-1)).resolves.toBeNull()
  })

  it('builds the permutation once however many positions are asked for', async () => {
    const source = base(40)
    const order = createShuffledPlayOrder(source, { seed: 5 })

    await walk(order, 40)

    expect(source.count).toHaveBeenCalledTimes(1)
  })

  it('falls back to linear traversal when the length cannot be established', async () => {
    // A failed count should cost the user a shuffle, not the rest of the
    // album: traversal continues rather than stopping dead.
    const source = base(null)
    source.at = vi.fn(async (index: number) => (index < 5 ? track(index) : null))
    const order = createShuffledPlayOrder(source, { seed: 5 })

    expect(await walk(order, 5)).toEqual([0, 1, 2, 3, 4])
  })

  it('reports the length of the order it permutes', async () => {
    await expect(createShuffledPlayOrder(base(40), { seed: 5 }).count()).resolves.toBe(40)
  })

  it('identifies orderings that traverse the same rows in the same sequence', () => {
    const source = base(40)
    const id = (seed: number, pinnedBaseIndex?: number): string =>
      createShuffledPlayOrder(source, { seed, ...(pinnedBaseIndex ? { pinnedBaseIndex } : {}) }).id

    expect(id(1)).toBe(id(1))
    expect(id(1)).not.toBe(id(2))
    // Same rows, same seed, different sequence — so a different order.
    expect(id(1)).not.toBe(id(1, 9))
    expect(id(1)).not.toBe(createShuffledPlayOrder(base(40, 'list:album:asc'), { seed: 1 }).id)
  })

  it('keeps the order it permutes, for restoring linear traversal', () => {
    const source = base(40)
    expect(createShuffledPlayOrder(source, { seed: 5 }).base).toBe(source)
  })
})
