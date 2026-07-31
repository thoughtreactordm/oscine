import type { Track } from '@shared/library'
import type { PlayOrder } from './playOrder'

/**
 * Shuffle as a `PlayOrder` that permutes another one.
 *
 * This is the shape `playOrder.ts` was written for: "W5 replaces the
 * implementation and nothing above this line changes". Every consumer keeps
 * working unmodified — the scheduler still prefetches position + 1 and arms a
 * boundary against it, the transport still counts in positions, and W5's
 * up-next pane can list what is actually coming rather than a guess.
 *
 * ## Why a permutation and not a random next
 *
 * Picking a random position at each boundary is a few lines and wrong in three
 * ways: tracks repeat before the order is exhausted, Previous has nothing to
 * go back to, and nothing can be displayed ahead of the current row. A
 * permutation is a bijection, so all three fall out for free.
 *
 * ## Why not ordering by a hash in SQL
 *
 * Tempting, because it would make shuffle just another sort and cost nothing
 * here. But every position resolves through `LIMIT 1 OFFSET n`, and an
 * expression sort has no index to walk — each one becomes a full sort of the
 * matching rows. At the 100k target that is a boundary miss, not a slow query.
 *
 * ## Cost
 *
 * One `Int32Array` of the order's length: 400 KB at 100k tracks, held only
 * while a shuffled order is playing. The inverse mapping is deliberately not
 * built — the one place a base position has to be recovered is turning shuffle
 * off, which needs a single lookup and can pay for it.
 */

export interface ShufflePlan {
  /**
   * Chosen fresh each time shuffle is switched on, so switching it off and
   * back on reshuffles. Injected rather than drawn here to keep the order
   * reproducible under test.
   */
  seed: number

  /**
   * A base position to place first.
   *
   * This is what makes enabling shuffle mid-track not an interruption: the
   * playing row is moved to position 0 of the new order and everything else is
   * shuffled behind it. It is also what makes clicking a row with shuffle
   * already on play *that* row rather than a surprise.
   */
  pinnedBaseIndex?: number
}

export interface ShuffledPlayOrder extends PlayOrder {
  /** The order being permuted, for restoring linear traversal. */
  readonly base: PlayOrder

  /** The position in `base` that this order's position names. */
  baseIndexAt(index: number): Promise<number | null>
}

/**
 * A small, fast, seeded PRNG.
 *
 * `Math.random` cannot be seeded, and an unseeded shuffle is one nobody can
 * write a test for. Nothing here is security-sensitive; mulberry32 passes the
 * statistical tests that matter for a play order and is eight lines.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function createShuffledPlayOrder(base: PlayOrder, plan: ShufflePlan): ShuffledPlayOrder {
  const { seed } = plan
  const pinned =
    plan.pinnedBaseIndex !== undefined &&
    Number.isInteger(plan.pinnedBaseIndex) &&
    plan.pinnedBaseIndex >= 0
      ? plan.pinnedBaseIndex
      : null

  // Built on first use rather than at construction, and this is not laziness
  // for its own sake: the permutation needs the order's length, which is a
  // round trip, and the click that starts playback must not wait for it. The
  // pinned row resolves without the permutation, so the first track is already
  // decoding while this is still being built.
  let permuted: Promise<Int32Array | null> | null = null

  function permutation(): Promise<Int32Array | null> {
    permuted ??= (async () => {
      const total = await base.count()
      if (total === null || total <= 0) {
        // Degrade to the base order rather than to an empty one. A count that
        // failed should cost the user a shuffle, not the rest of the album.
        permuted = null
        return null
      }

      const order = new Int32Array(total)
      for (let i = 0; i < total; i += 1) order[i] = i

      const random = mulberry32(seed)
      for (let i = total - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        const swap = order[i]!
        order[i] = order[j]!
        order[j] = swap
      }

      if (pinned !== null && pinned < total) {
        // A swap rather than a splice: the pinned row goes to the front and
        // whatever was there takes its place, which keeps the result a
        // permutation. Fisher-Yates has already run, so the displaced row is
        // in a position as arbitrary as any other.
        const at = order.indexOf(pinned)
        if (at > 0) {
          order[at] = order[0]!
          order[0] = pinned
        }
      }

      return order
    })()
    return permuted
  }

  async function baseIndexAt(index: number): Promise<number | null> {
    if (!Number.isInteger(index) || index < 0) return null
    // The one position that must resolve without waiting for the length.
    if (index === 0 && pinned !== null) return pinned

    const order = await permutation()
    // No length, no shuffle: fall through to the base order's own positions so
    // traversal continues instead of stopping dead.
    if (!order) return index
    return index < order.length ? order[index]! : null
  }

  return {
    base,

    // The pin is part of the identity: two orders with the same id have to
    // traverse the same rows in the same sequence, and the same seed pinned to
    // a different row does not.
    id: `shuffle:${seed}:${pinned ?? '-'}:${base.id}`,

    count: () => base.count(),
    baseIndexAt,

    async at(index: number): Promise<Track | null> {
      const baseIndex = await baseIndexAt(index)
      return baseIndex === null ? null : base.at(baseIndex)
    }
  }
}
