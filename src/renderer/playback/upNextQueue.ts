import { computed, shallowRef, type ComputedRef } from 'vue'
import type { Track } from '@shared/library'
import { needsTotal, nextIndex, type AdvanceReason, type RepeatMode } from './traversal'

/**
 * The transient up-next queue, and the one seam every §5 rule lives in.
 *
 * The queue sits *above* traversal rather than inside it. A `PlayOrder` still
 * answers "what is at position n" and `traversal.ts` still answers "which
 * position follows this one"; neither knows the queue exists. `chooseSuccessor`
 * below is the only place the two arms of rule 1 meet, which is why the rules
 * can be quoted at branches instead of paraphrased across three files.
 *
 * Headless on purpose. Everything here is decidable from a queue, a position, a
 * length and the two modes — no engine, no scheduler, no Pinia — so the rules
 * are tested against the thing that implements them rather than through an
 * audio graph that happens to exercise it.
 *
 * ## Not persisted (§5 rule 5)
 *
 * This is deliberate, and it will look like an oversight to whoever reads it
 * next, so: playlists are persisted and the queue is not. It holds no storage,
 * takes no `TransportStorage`, and writes nothing — a restart starts empty. The
 * queue is a statement about the next few minutes, and a stale one restored
 * from last week is worse than none. Revisit it when there is a session-restore
 * feature that restores what was *playing* too; until then a persisted queue
 * would resume pointing at a track the user has forgotten enqueueing.
 */

/**
 * One row of the queue.
 *
 * `trackId` is the identity that matters, and it is the whole of rule 4's first
 * half: nothing here references a playlist or a `playlist_entries.id`, so
 * deleting the playlist a row was queued from cannot reach it.
 *
 * `id` exists because D12 makes the same track legal twice — in a playlist and
 * therefore in the queue, since queueing a playlist's selection can hand over
 * two copies of one track. Two such rows are distinct rows and each has to be
 * removable and movable on its own, exactly as `playlist_entries.id` is the
 * identity there and `track_id` never is.
 *
 * `track` is a display snapshot taken when the row was queued, the same bargain
 * `PlayFromListParams.track` strikes: whatever offered the user the row is
 * holding the `Track` already, so carrying it keeps the play path free of a
 * round trip for something the UI had in hand. It is not the identity — a tag
 * edit makes it stale and rule 4 still holds, because `trackId` did not move.
 */
export interface QueueEntry {
  readonly id: string
  readonly trackId: number
  readonly track: Track
}

/**
 * Where a slot's track sits, which under a queue is two facts rather than one.
 *
 * `index` is the order position and `queueEntryId` says whether the audible
 * track is that row or a queue detour taken from it.
 */
export interface SlotPosition {
  /**
   * The order position. For a track that came from the queue this is the
   * position traversal *resumes at*, not where the track is — the queue is a
   * detour, and rule 1's "the next entry after the current one" means the entry
   * after the row the detour was taken from. A queue track therefore inherits
   * this unchanged, however many of them play in a row.
   */
  readonly index: number
  /** The queue entry this names, or `null` when it names the order row at `index`. */
  readonly queueEntryId: string | null
}

export function orderPosition(index: number): SlotPosition {
  return { index, queueEntryId: null }
}

export function samePosition(a: SlotPosition | null, b: SlotPosition | null): boolean {
  if (a === null || b === null) return a === b
  return a.index === b.index && a.queueEntryId === b.queueEntryId
}

/**
 * What follows the current track, and which of rule 1's arms said so.
 *
 * The kind is not decoration: each arm resolves its track from a different
 * place. `queue` carries its own row, `order` needs a `PlayOrder.at()` lookup,
 * and `again` is whatever is already audible.
 */
export type Successor =
  /** §5 rule 1, first arm: the queue head. */
  | { readonly kind: 'queue'; readonly position: SlotPosition; readonly entry: QueueEntry }
  /** §5 rule 1, second arm: the next row of the playing order. */
  | { readonly kind: 'order'; readonly position: SlotPosition }
  /** §5 rule 7: repeat-one at a boundary — whatever is audible, again. */
  | { readonly kind: 'again'; readonly position: SlotPosition }

/**
 * Whether the order's length has to be resolved before a successor can be named.
 *
 * `needsTotal` answers this for traversal alone; the queue makes the answer
 * "no" more often, because a queue head wins without anyone asking how long the
 * playing playlist is. Consulted so the round trip is skipped rather than
 * awaited and discarded — the same bargain `needsTotal` exists to strike.
 */
export function successorNeedsTotal(
  head: QueueEntry | null,
  repeat: RepeatMode,
  reason: AdvanceReason
): boolean {
  // Rule 7: repeat-one at a boundary names the current position, and rule 1:
  // the queue head wins outright. Neither can wrap, so neither needs a length.
  if (repeat === 'one' && reason === 'boundary') return false
  if (head !== null) return false
  return needsTotal(repeat, reason)
}

export interface ChooseSuccessorInput {
  /** Where the audible track sits. */
  from: SlotPosition
  /** The queue head, or `null` when the queue is empty. Peeked, never shifted. */
  head: QueueEntry | null
  /** The order's length, or `null` when unknown. See `successorNeedsTotal`. */
  total: number | null
  repeat: RepeatMode
  reason: AdvanceReason
}

/**
 * The seam. §5 rule 1, with rules 6 and 7 falling out of where the branches sit.
 *
 * Deliberately pure and deliberately not the shift: peeking and consuming are
 * separate because prefetch has to warm the head long before the boundary that
 * consumes it, and a Next pressed in between must find the queue as it was. The
 * shift belongs to whoever commits the advance — see `UpNextQueue.take`.
 */
export function chooseSuccessor(input: ChooseSuccessorInput): Successor | null {
  const { from, head, total, repeat, reason } = input

  // §5 rule 7, first sentence: "Repeat-one overrides everything." Including the
  // queue, and including a queue track that is itself the thing repeating —
  // `again` names the audible track whichever arm produced it. Only at a
  // boundary: pressing Next under repeat-one moves on, as `traversal.ts` says.
  if (repeat === 'one' && reason === 'boundary') {
    return { kind: 'again', position: from }
  }

  // §5 rule 1, first arm, and the second half of rule 7: under repeat-all "the
  // queue still takes priority", which is this branch sitting above the wrap
  // rather than a case inside it. Rule 6 is here too, by absence — shuffle
  // permutes what `nextIndex` walks, and never reaches this line.
  if (head !== null) {
    return { kind: 'queue', position: { index: from.index, queueEntryId: head.id }, entry: head }
  }

  // §5 rule 1, second arm: the next entry after the current one in the playing
  // playlist. `from.index` is the anchor, so a drained queue resumes after the
  // row the detour was taken from rather than after the detour.
  const index = nextIndex(from.index, total, repeat, reason)
  return index === null ? null : { kind: 'order', position: orderPosition(index) }
}

/** What the scheduler needs of the queue: peek, resolve, and the shift. */
export interface SuccessorQueue {
  head(): QueueEntry | null
  entry(id: string): QueueEntry | null
  /**
   * §5 rule 1's shift, performed at the moment an advance commits.
   *
   * Guarded rather than a bare `shift()`, and idempotent: an explicit Next
   * consumes the head synchronously so two fast presses take two rows, and the
   * scheduler consumes it again when the slot is actually adopted. Whichever
   * arrives second finds the row gone and does nothing.
   */
  take(id: string): void
}

export interface UpNextQueue extends SuccessorQueue {
  /** The queue, in play order. */
  readonly entries: ComputedRef<readonly QueueEntry[]>
  readonly count: ComputedRef<number>
  readonly isEmpty: ComputedRef<boolean>
  /** "Add to queue": appended, in the order given. */
  enqueue(tracks: readonly Track[]): QueueEntry[]
  /** "Play next": inserted at the head, in the order given. */
  enqueueNext(tracks: readonly Track[]): QueueEntry[]
  remove(id: string): boolean
  /** Moves one row to `toIndex`, clamped to the queue. Positions are the drag's. */
  move(id: string, toIndex: number): boolean
  clear(): void
}

export interface UpNextQueueDeps {
  /**
   * Called after any edit the user made, so a decode already armed against the
   * old head can be re-decided.
   *
   * Not called by `take`, which *is* an advance: the advance re-prefetches on
   * its own, and firing here as well would discard the successor it just chose.
   */
  onChange?: () => void
}

export function createUpNextQueue(deps: UpNextQueueDeps = {}): UpNextQueue {
  // Shallow, and every edit replaces the array rather than splicing it.
  // A deep `ref` would hand back a Proxy of every `Track` it holds, and the
  // rest of playback deliberately keeps Vue's proxies away from values that
  // cross into the audio path — `controller.ts` says the same thing about the
  // engine. Entries are immutable, so nothing below the array needs tracking.
  const entries = shallowRef<readonly QueueEntry[]>([])
  // Monotonic and queue-local. Ids are only ever compared within one queue, and
  // a counter is reproducible in a way a clock or a random source is not.
  let minted = 0

  function mint(track: Track): QueueEntry {
    minted += 1
    return { id: `q${minted}`, trackId: track.id, track }
  }

  function changed(): void {
    deps.onChange?.()
  }

  function insert(tracks: readonly Track[], at: number): QueueEntry[] {
    if (tracks.length === 0) return []
    const added = tracks.map(mint)
    entries.value = [...entries.value.slice(0, at), ...added, ...entries.value.slice(at)]
    changed()
    return added
  }

  function indexOf(id: string): number {
    return entries.value.findIndex((candidate) => candidate.id === id)
  }

  return {
    entries: computed(() => entries.value),
    count: computed(() => entries.value.length),
    isEmpty: computed(() => entries.value.length === 0),

    head: () => entries.value[0] ?? null,
    entry: (id) => entries.value.find((candidate) => candidate.id === id) ?? null,

    enqueue: (tracks) => insert(tracks, entries.value.length),
    enqueueNext: (tracks) => insert(tracks, 0),

    remove(id) {
      const at = indexOf(id)
      if (at === -1) return false
      entries.value = entries.value.filter((_, position) => position !== at)
      changed()
      return true
    },

    move(id, toIndex) {
      const from = indexOf(id)
      if (from === -1 || !Number.isInteger(toIndex)) return false
      const to = Math.min(Math.max(toIndex, 0), entries.value.length - 1)
      if (to === from) return false
      const without = entries.value.filter((_, position) => position !== from)
      const moved = entries.value[from]
      if (!moved) return false
      entries.value = [...without.slice(0, to), moved, ...without.slice(to)]
      changed()
      return true
    },

    clear() {
      if (entries.value.length === 0) return
      entries.value = []
      changed()
    },

    take(id) {
      const at = indexOf(id)
      if (at === -1) return
      entries.value = entries.value.filter((_, position) => position !== at)
    }
  }
}
