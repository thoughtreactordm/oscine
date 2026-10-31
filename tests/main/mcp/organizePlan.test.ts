import { describe, expect, it } from 'vitest'
import type { PlaylistInsertion } from '@shared/playlists'
import {
  assertWithinCap,
  insertionIndex,
  MAX_ORGANIZE_BATCH,
  planMove,
  planOrder
} from '../../../src/main/mcp/organize/plan'
import type { OrganizeEntry } from '../../../src/main/mcp/organize/reads'
import { ToolInputError } from '../../../src/main/mcp/tools/common'

/**
 * The Organize planner — **W24-7**, D36.7: the diff a `dryRun` reports and the
 * check a real call makes, mirroring the playlist store's own semantics.
 */

const entriesOf = (ids: number[]): OrganizeEntry[] =>
  ids.map((entryId) => ({ entryId, trackId: entryId * 10 }))

/** Applies single-entry moves the way the store does, for checking a plan lands. */
function applyMoves(
  order: number[],
  moves: Array<{ entryId: number; insertion: PlaylistInsertion }>
) {
  let current = [...order]
  for (const move of moves) {
    current = planMove(entriesOf(current), [move.entryId], move.insertion).order
  }
  return current
}

/** A small seeded PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31
    return state / 2 ** 31
  }
}

describe('organize plan', () => {
  it('refuses a batch over the cap with how to split it', () => {
    expect(() => assertWithinCap(MAX_ORGANIZE_BATCH, 'tracks')).not.toThrow()
    expect(() => assertWithinCap(1200, 'tracks')).toThrow(/1200 tracks .* 3 calls of at most 500/)
  })

  it('resolves insertions against the order without the moved entries', () => {
    const order = [1, 2, 3, 4]
    expect(insertionIndex(order, { at: 'start' })).toBe(0)
    expect(insertionIndex(order, { at: 'end' })).toBe(4)
    expect(insertionIndex(order, { at: 'before', entryId: 3 })).toBe(2)
    expect(insertionIndex(order, { at: 'after', entryId: 3 }, new Set([1]))).toBe(2)
    expect(() => insertionIndex(order, { at: 'after', entryId: 9 })).toThrow(ToolInputError)
  })

  it('moves a block in playlist order, and treats an anchor inside it as a no-op', () => {
    const entries = entriesOf([1, 2, 3, 4, 5])
    expect(planMove(entries, [4, 2], { at: 'start' })).toEqual({ order: [2, 4, 1, 3, 5], at: 0 })
    expect(planMove(entries, [1], { at: 'after', entryId: 5 })).toEqual({
      order: [2, 3, 4, 5, 1],
      at: 4
    })
    expect(planMove(entries, [2, 3], { at: 'after', entryId: 3 }).at).toBeNull()
    expect(() => planMove(entries, [8], { at: 'end' })).toThrow(/not in this playlist/)
  })

  it('needs no moves for an order that already holds', () => {
    expect(planOrder(entriesOf([1, 2, 3]), [1, 2, 3])).toEqual([])
  })

  it('moves only what is out of place', () => {
    // 5 to the front: the rest stay.
    const moves = planOrder(entriesOf([1, 2, 3, 4, 5]), [5, 1, 2, 3, 4])
    expect(moves).toEqual([{ entryId: 5, insertion: { at: 'start' } }])
  })

  it('lands on any permutation', () => {
    const random = rng(7)
    for (let round = 0; round < 50; round += 1) {
      const n = 1 + Math.floor(random() * 40)
      const order = Array.from({ length: n }, (_, i) => i + 1)
      const target = [...order]
      for (let i = n - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        ;[target[i], target[j]] = [target[j]!, target[i]!]
      }
      expect(applyMoves(order, planOrder(entriesOf(order), target))).toEqual(target)
    }
  })

  it('refuses an order that does not name every entry exactly once', () => {
    const entries = entriesOf([1, 2, 3])
    expect(() => planOrder(entries, [1, 2])).toThrow(/every entry/)
    expect(() => planOrder(entries, [1, 2, 2])).toThrow(/every entry/)
    expect(() => planOrder(entries, [1, 2, 7])).toThrow(/not in this playlist/)
  })
})
