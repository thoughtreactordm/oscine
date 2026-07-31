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
 * ## Two tiers (§5 amendment, 2026-07-31)
 *
 * The queue is not one list but two, kept in one array with the **user tier
 * always above the session tier**. A user entry is something put here by hand;
 * a session entry is an order row materialized from the scope playback started
 * in, so that the several hundred tracks a facet selection genuinely lines up
 * are rows the operator can see rather than a lazy query nothing can render.
 *
 * The split is not presentational. It is what keeps rule 3's guarantee whole —
 * clicking a library row replaces the session tier and leaves hand-queued
 * tracks alone — and it is what keeps "Add to queue" meaningful, since an
 * append against a loaded 300-track session would otherwise mean "in four
 * hours". `enqueue` therefore lands at the tail of the *user* tier, not at the
 * tail of the queue.
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
 * Which tier an entry belongs to, and with it what its position *means*.
 *
 * Not decoration: a user entry is a detour from the row it interrupts and a
 * session entry *is* an order row. Rule 1's anchor, Previous, and what a jump
 * discards all fork on this.
 */
export type QueueOrigin = 'user' | 'session'

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
 *
 * `orderIndex` is the position in the playing order this entry *is*, and it is
 * non-null exactly for session entries. It is what makes a capped session tier
 * correct rather than merely truncated: draining the cap resumes at the row
 * after the last one materialized, instead of at the anchor the session started
 * from. A user entry has none, because a detour is not a row of the order.
 */
export interface QueueEntry {
  readonly id: string
  readonly trackId: number
  readonly track: Track
  readonly origin: QueueOrigin
  readonly orderIndex: number | null
}

/** One materialized order row, as `fillSession` takes them. */
export interface SessionRow {
  readonly track: Track
  readonly orderIndex: number
}

/**
 * Where a slot's track sits, which under a queue is two facts rather than one.
 *
 * `index` is the order position and `queueEntryId` says whether the audible
 * track is that row or a queue detour taken from it.
 */
export interface SlotPosition {
  /**
   * The order position.
   *
   * For a **user** entry this is the position traversal *resumes at*, not where
   * the track is — that queue is a detour, and rule 1's "the next entry after
   * the current one" means the entry after the row the detour was taken from.
   * Such an entry inherits this unchanged, however many play in a row.
   *
   * For a **session** entry it is the entry's own `orderIndex`, because a
   * session entry is not a detour: it *is* the order row, materialized. Without
   * this a session tier holding rows 1..N against an anchor still at 0 would
   * replay the scope from its second track the moment it drained.
   */
  readonly index: number
  /** The queue entry this names, or `null` when it names the order row at `index`. */
  readonly queueEntryId: string | null
  /**
   * Which tier `queueEntryId` came from; absent when it is `null`.
   *
   * Carried on the position rather than looked up, because by the time anything
   * asks, the entry has been shifted out of the queue — rule 1's take happens
   * when the advance commits. Previous is what needs it: backing out of a user
   * detour returns to the row it interrupted, whereas a session entry *is* that
   * row and Previous has to go to the one before it.
   */
  readonly queueOrigin?: QueueOrigin
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
  //
  // The anchor forks on the tier, which is the whole of the amendment's second
  // consequence: a user entry inherits the interrupted row, a session entry
  // carries its own. `orderIndex` is non-null exactly when `origin` is
  // `session`, so the `??` is the total function and not a fallback.
  if (head !== null) {
    return {
      kind: 'queue',
      position: {
        index: head.orderIndex ?? from.index,
        queueEntryId: head.id,
        queueOrigin: head.origin
      },
      entry: head
    }
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
  /** The queue, in play order: the user tier, then the session tier. */
  readonly entries: ComputedRef<readonly QueueEntry[]>
  readonly count: ComputedRef<number>
  readonly isEmpty: ComputedRef<boolean>
  /** Hand-queued rows only — what the transport badge counts. */
  readonly userEntries: ComputedRef<readonly QueueEntry[]>
  readonly userCount: ComputedRef<number>
  /** Materialized scope rows only. */
  readonly sessionEntries: ComputedRef<readonly QueueEntry[]>
  readonly sessionCount: ComputedRef<number>
  /**
   * "Add to queue": appended to the **user tier**, so it lands above the
   * session tier rather than behind four hours of it.
   */
  enqueue(tracks: readonly Track[]): QueueEntry[]
  /** "Play next": inserted at the head, in the order given. */
  enqueueNext(tracks: readonly Track[]): QueueEntry[]
  /** Replaces the session tier wholesale. Never touches the user tier. */
  fillSession(rows: readonly SessionRow[]): QueueEntry[]
  clearSession(): void
  remove(id: string): boolean
  /**
   * Moves one row within its own tier, clamped to that tier.
   *
   * Tier-local rather than queue-global because the invariant is the queue's to
   * keep, not its callers': a drag that dropped a hand-queued row under the
   * session tier would silently mean "in four hours".
   */
  move(id: string, toIndex: number): boolean
  /**
   * §5 rule 1's shift for a *jump*, which is tier-dependent.
   *
   * A user entry leaves alone; W5-5's decision stands — a jump destroys
   * nothing. A session entry takes every session entry above it with it: those
   * rows are behind the operator now, and leaving them would replay the scope
   * from where the jump started.
   */
  takeThrough(id: string): void
  /** Clears the hand-queued rows, leaving the scope standing. */
  clearUser(): void
  /** Clears both tiers. */
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

  function mint(track: Track, origin: QueueOrigin, orderIndex: number | null): QueueEntry {
    minted += 1
    return { id: `q${minted}`, trackId: track.id, track, origin, orderIndex }
  }

  function changed(): void {
    deps.onChange?.()
  }

  /**
   * Where the user tier ends and the session tier begins.
   *
   * Derived rather than stored, so the boundary cannot fall out of step with
   * the array it describes — every edit below rebuilds the array whole, and a
   * cached index would be one more thing each of them had to remember.
   */
  function userLength(): number {
    const at = entries.value.findIndex((candidate) => candidate.origin === 'session')
    return at === -1 ? entries.value.length : at
  }

  function insert(tracks: readonly Track[], at: number): QueueEntry[] {
    if (tracks.length === 0) return []
    const added = tracks.map((track) => mint(track, 'user', null))
    entries.value = [...entries.value.slice(0, at), ...added, ...entries.value.slice(at)]
    changed()
    return added
  }

  function indexOf(id: string): number {
    return entries.value.findIndex((candidate) => candidate.id === id)
  }

  const userEntries = computed(() => entries.value.filter((entry) => entry.origin === 'user'))
  const sessionEntries = computed(() => entries.value.filter((entry) => entry.origin === 'session'))

  return {
    entries: computed(() => entries.value),
    count: computed(() => entries.value.length),
    isEmpty: computed(() => entries.value.length === 0),
    userEntries,
    userCount: computed(() => userEntries.value.length),
    sessionEntries,
    sessionCount: computed(() => sessionEntries.value.length),

    head: () => entries.value[0] ?? null,
    entry: (id) => entries.value.find((candidate) => candidate.id === id) ?? null,

    // The tail of the *user* tier, which is the point of the split: appending
    // to the true tail against a loaded session means "in four hours".
    enqueue: (tracks) => insert(tracks, userLength()),
    enqueueNext: (tracks) => insert(tracks, 0),

    fillSession(rows) {
      const kept = entries.value.slice(0, userLength())
      if (rows.length === 0 && kept.length === entries.value.length) return []
      const added = rows.map((row) => mint(row.track, 'session', row.orderIndex))
      entries.value = [...kept, ...added]
      changed()
      return added
    },

    clearSession() {
      const kept = entries.value.slice(0, userLength())
      if (kept.length === entries.value.length) return
      entries.value = kept
      changed()
    },

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
      const moved = entries.value[from]
      if (!moved) return false
      // Clamped to the mover's own tier, so a drag cannot cross the boundary.
      const boundary = userLength()
      const [lower, upper] =
        moved.origin === 'user' ? [0, boundary - 1] : [boundary, entries.value.length - 1]
      const to = Math.min(Math.max(toIndex, lower), upper)
      if (to === from) return false
      const without = entries.value.filter((_, position) => position !== from)
      entries.value = [...without.slice(0, to), moved, ...without.slice(to)]
      changed()
      return true
    },

    clearUser() {
      const boundary = userLength()
      if (boundary === 0) return
      entries.value = entries.value.slice(boundary)
      changed()
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
    },

    takeThrough(id) {
      const at = indexOf(id)
      if (at === -1) return
      const target = entries.value[at]
      if (!target) return
      if (target.origin === 'user') {
        entries.value = entries.value.filter((_, position) => position !== at)
        return
      }
      // Everything at or above it that is a session row goes; the user tier
      // sits above the session tier and is not "behind" anything.
      entries.value = entries.value.filter(
        (candidate, position) => position > at || candidate.origin !== 'session'
      )
    }
  }
}
