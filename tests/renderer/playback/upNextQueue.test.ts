import { describe, expect, it, vi } from 'vitest'
import {
  chooseSuccessor,
  createUpNextQueue,
  orderPosition,
  samePosition,
  successorNeedsTotal,
  type QueueEntry,
  type SlotPosition,
  type Successor
} from '../../../src/renderer/playback/upNextQueue'
import type { AdvanceReason, RepeatMode } from '../../../src/renderer/playback/traversal'
import type { Track } from '../../../src/shared/library'

/**
 * The seven §5 rules, proved against the model that implements them.
 *
 * Nothing here builds an `AudioEngine`, a scheduler or a `PlayOrder`. That is
 * the point: rule 1's seam is a pure function over a queue, a position, a
 * length and the two modes, and if the rules could only be demonstrated through
 * an audio graph then the audio graph would be where they actually lived.
 * `controller.test.ts` carries the same seven numbers through the transport.
 */

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
    favorite: false,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** Resolves a successor the way the scheduler does, round trip and all. */
function successorOf(options: {
  from: SlotPosition
  head?: QueueEntry | null
  total?: number | null
  repeat?: RepeatMode
  reason?: AdvanceReason
}): Successor | null {
  const head = options.head ?? null
  const repeat = options.repeat ?? 'off'
  const reason = options.reason ?? 'boundary'
  const total = successorNeedsTotal(head, repeat, reason) ? (options.total ?? null) : null
  return chooseSuccessor({ from: options.from, head, total, repeat, reason })
}

const ids = (entries: readonly QueueEntry[]): number[] => entries.map((entry) => entry.trackId)

describe('the up-next queue', () => {
  describe('operations', () => {
    it('appends in the order given and inserts at the head for play-next', () => {
      const queue = createUpNextQueue()
      queue.enqueue([track(1), track(2)])
      queue.enqueueNext([track(8), track(9)])

      expect(ids(queue.entries.value)).toEqual([8, 9, 1, 2])
      expect(queue.head()?.trackId).toBe(8)
      expect(queue.count.value).toBe(4)
    })

    it('gives duplicate tracks distinct removable rows', () => {
      // D12 makes the same track legal twice in a playlist, so queueing a
      // playlist's selection can hand over two copies of one track. `track_id`
      // is never the identity of a row — here for exactly the reason it is
      // never the identity of a `playlist_entries` row.
      const queue = createUpNextQueue()
      const [first, second] = queue.enqueue([track(4), track(4)])

      expect(first?.id).not.toBe(second?.id)
      queue.remove(first?.id ?? '')
      expect(queue.entries.value).toHaveLength(1)
      expect(queue.entries.value[0]?.id).toBe(second?.id)
    })

    it('moves one row, clamping the target into the queue', () => {
      const queue = createUpNextQueue()
      const entries = queue.enqueue([track(1), track(2), track(3)])

      expect(queue.move(entries[2]?.id ?? '', 0)).toBe(true)
      expect(ids(queue.entries.value)).toEqual([3, 1, 2])
      expect(queue.move(entries[2]?.id ?? '', 99)).toBe(true)
      expect(ids(queue.entries.value)).toEqual([1, 2, 3])
    })

    it('keeps the user tier above the session tier however it is filled', () => {
      const queue = createUpNextQueue()
      queue.fillSession([
        { track: track(10), orderIndex: 1 },
        { track: track(11), orderIndex: 2 }
      ])
      queue.enqueue([track(1)])
      queue.enqueue([track(2)])
      queue.enqueueNext([track(3)])

      // Play-next at the absolute head; add-to-queue at the tail of the *user*
      // tier, which is what stops an append meaning "in four hours".
      expect(ids(queue.entries.value)).toEqual([3, 1, 2, 10, 11])
      expect(ids(queue.userEntries.value)).toEqual([3, 1, 2])
      expect(ids(queue.sessionEntries.value)).toEqual([10, 11])
      expect(queue.userCount.value).toBe(3)
      expect(queue.sessionCount.value).toBe(2)
    })

    it('replaces the session tier wholesale and leaves the user tier alone', () => {
      const queue = createUpNextQueue()
      const hand = queue.enqueue([track(1), track(2)])
      queue.fillSession([{ track: track(10), orderIndex: 1 }])

      queue.fillSession([
        { track: track(20), orderIndex: 5 },
        { track: track(21), orderIndex: 6 }
      ])

      expect(queue.userEntries.value).toEqual(hand)
      expect(ids(queue.sessionEntries.value)).toEqual([20, 21])

      queue.clearSession()
      expect(queue.entries.value).toEqual(hand)
    })

    it('carries an order index on a session row and none on a hand-queued one', () => {
      const queue = createUpNextQueue()
      const [hand] = queue.enqueue([track(1)])
      const [session] = queue.fillSession([{ track: track(10), orderIndex: 7 }])

      expect(hand?.origin).toBe('user')
      expect(hand?.orderIndex).toBeNull()
      expect(session?.origin).toBe('session')
      expect(session?.orderIndex).toBe(7)
    })

    it('clamps a move into the mover own tier rather than into the queue', () => {
      // The invariant is the queue's to keep, not its callers': a drag that
      // dropped a hand-queued row under the session tier would silently mean
      // "in four hours".
      const queue = createUpNextQueue()
      const hand = queue.enqueue([track(1), track(2)])
      const session = queue.fillSession([
        { track: track(10), orderIndex: 1 },
        { track: track(11), orderIndex: 2 }
      ])

      expect(queue.move(hand[0]?.id ?? '', 99)).toBe(true)
      expect(ids(queue.entries.value)).toEqual([2, 1, 10, 11])

      expect(queue.move(session[1]?.id ?? '', 0)).toBe(true)
      expect(ids(queue.entries.value)).toEqual([2, 1, 11, 10])
    })

    it('takes the session rows above a jump and only the row itself for a user jump', () => {
      const queue = createUpNextQueue()
      queue.enqueue([track(1), track(2)])
      const session = queue.fillSession([
        { track: track(10), orderIndex: 1 },
        { track: track(11), orderIndex: 2 },
        { track: track(12), orderIndex: 3 }
      ])

      // A session row is an order row: everything above it is behind the
      // operator now. The user tier is above the session tier and is not.
      queue.takeThrough(session[1]?.id ?? '')
      expect(ids(queue.entries.value)).toEqual([1, 2, 12])

      // A user row destroys nothing but itself — W5-5's decision, unchanged.
      queue.takeThrough(queue.entries.value[1]?.id ?? '')
      expect(ids(queue.entries.value)).toEqual([1, 12])
    })

    it('reports an edit that changed nothing as no edit', () => {
      const onChange = vi.fn()
      const queue = createUpNextQueue({ onChange })
      const [entry] = queue.enqueue([track(1)])
      onChange.mockClear()

      expect(queue.move(entry?.id ?? '', 0)).toBe(false)
      expect(queue.remove('nothing')).toBe(false)
      queue.enqueue([])
      expect(onChange).not.toHaveBeenCalled()

      queue.clear()
      expect(onChange).toHaveBeenCalledTimes(1)
      queue.clear()
      expect(onChange).toHaveBeenCalledTimes(1)
    })

    it('shifts a row without announcing an edit', () => {
      // `take` is the advance itself, not something the user did to the queue.
      // Announcing it would have the advance discard the successor it has just
      // chosen and decided to decode.
      const onChange = vi.fn()
      const queue = createUpNextQueue({ onChange })
      const [entry] = queue.enqueue([track(1), track(2)])
      onChange.mockClear()

      queue.take(entry?.id ?? '')
      expect(ids(queue.entries.value)).toEqual([2])
      expect(onChange).not.toHaveBeenCalled()
    })

    it('lets the second of two takes find the row already gone', () => {
      // An explicit Next consumes the head synchronously so two fast presses
      // take two rows; the scheduler consumes it again when the slot is
      // actually adopted. Whichever arrives second must do nothing.
      const queue = createUpNextQueue()
      const [entry] = queue.enqueue([track(1), track(2)])

      queue.take(entry?.id ?? '')
      queue.take(entry?.id ?? '')
      expect(ids(queue.entries.value)).toEqual([2])
    })
  })

  describe('the seven §5 rules', () => {
    it('rule 1: the successor is the queue head when the queue is non-empty, and the next row of the playing order otherwise', () => {
      const queue = createUpNextQueue()
      const [queued] = queue.enqueue([track(77)])
      const from = orderPosition(4)

      const first = successorOf({ from, head: queue.head(), total: 10 })
      expect(first).toEqual({
        kind: 'queue',
        position: { index: 4, queueEntryId: queued?.id, queueOrigin: 'user' },
        entry: queued
      })

      // The shift on advance. With the queue drained, the same position names
      // the row after the one the detour was taken from — rule 1's second arm.
      queue.take(queued?.id ?? '')
      expect(successorOf({ from, head: queue.head(), total: 10 })).toEqual({
        kind: 'order',
        position: orderPosition(5)
      })
    })

    it('rule 1: a queue detour resumes traversal after the row it interrupted, not after itself', () => {
      const queue = createUpNextQueue()
      const [a, b] = queue.enqueue([track(70), track(71)])

      // Playing row 4, two entries queued by hand. Both inherit position 4 — a
      // *user* entry is a detour, and a detour does not move the place it was
      // taken from. The session tier is the half of the amendment that does;
      // see "a session entry carries its own order index" below.
      const first = successorOf({ from: orderPosition(4), head: queue.head(), total: 10 })
      expect(first?.position).toEqual({ index: 4, queueEntryId: a?.id, queueOrigin: 'user' })

      queue.take(a?.id ?? '')
      const second = successorOf({ from: first?.position ?? orderPosition(4), head: queue.head() })
      expect(second?.position).toEqual({ index: 4, queueEntryId: b?.id, queueOrigin: 'user' })

      queue.take(b?.id ?? '')
      const third = successorOf({ from: second?.position ?? orderPosition(4), head: queue.head() })
      expect(third).toEqual({ kind: 'order', position: orderPosition(5) })
    })

    it('rule 2: queueing changes neither the playing position nor which playlist is playing', () => {
      const queue = createUpNextQueue()
      const from = orderPosition(4)

      queue.enqueue([track(1)])
      queue.enqueueNext([track(2)])
      queue.move(queue.entries.value[1]?.id ?? '', 0)
      queue.remove(queue.entries.value[0]?.id ?? '')

      // Not one of those edits could move the position: every one of them is a
      // pure function of the queue, and the position is an argument the queue
      // is never handed. Rule 1 asks about `from` afterwards and gets the same
      // anchor back.
      //
      // Rule 2 as amended narrows to this tier: "only the user tier is
      // queueing". Filling the session tier is part of *starting* playback,
      // which moves the position by definition — see the session-tier tests.
      expect(successorOf({ from, head: queue.head() })?.position.index).toBe(4)

      // The playlist half is structural rather than behavioural: a queue row
      // has no field that could name a playlist to change. If a sixth key ever
      // appears here, rules 2 and 4 both need rereading — `origin` and
      // `orderIndex` arrived with the amendment and name a tier and an order
      // position, neither of which is a playlist.
      const [entry] = queue.enqueue([track(9)])
      expect(Object.keys(entry ?? {}).sort()).toEqual([
        'id',
        'orderIndex',
        'origin',
        'track',
        'trackId'
      ])
    })

    it('rule 1 as amended: a session entry carries its own order index, and a drained cap resumes after it', () => {
      // The second consequence of the amendment, and the one that is a real bug
      // rather than a nicety: a session tier holding the scope's rows 1..N
      // against an anchor still at 0 replays the scope from its second track
      // the moment it drains.
      const queue = createUpNextQueue()
      const session = queue.fillSession([
        { track: track(10), orderIndex: 1 },
        { track: track(11), orderIndex: 2 },
        { track: track(12), orderIndex: 3 }
      ])
      let from = orderPosition(0)

      for (const expected of [1, 2, 3]) {
        const successor = successorOf({ from, head: queue.head(), total: 100 })
        expect(successor?.position).toEqual({
          index: expected,
          queueEntryId: session[expected - 1]?.id,
          queueOrigin: 'session'
        })
        queue.take(session[expected - 1]?.id ?? '')
        from = successor?.position ?? from
      }

      // Row 4, not row 1. The anchor travelled with the tier, so a session
      // truncated by the cap is correct rather than merely truncated.
      expect(successorOf({ from, head: queue.head(), total: 100 })).toEqual({
        kind: 'order',
        position: orderPosition(4)
      })
    })

    it('rule 3: the queue survives playing from another playlist', () => {
      const queue = createUpNextQueue()
      queue.enqueue([track(1), track(2)])
      const before = [...queue.entries.value]

      // Playing from another playlist is, to the queue, a different `from` and
      // nothing else — there is no path into this module that could clear it.
      // The three that remove anything are `remove`, `clear` and the shift.
      for (const index of [0, 3, 9]) {
        expect(successorOf({ from: orderPosition(index), head: queue.head() })?.kind).toBe('queue')
      }
      expect(queue.entries.value).toEqual(before)
    })

    it('rule 4: a queued row survives the playlist it came from being deleted', () => {
      const queue = createUpNextQueue()
      const [entry] = queue.enqueue([track(1)])

      // The row references a track id and a display snapshot, and nothing else.
      // There is no playlist id and no `playlist_entries.id` on it, so deleting
      // the playlist it was queued from cannot reach it — that is the whole of
      // "the queue holds track ids".
      expect(entry?.trackId).toBe(1)
      expect(entry).not.toHaveProperty('playlistId')
      expect(entry).not.toHaveProperty('entryId')
      expect(queue.entry(entry?.id ?? '')).toBe(entry)
    })

    it('rule 5: the queue is transient — a new one starts empty and nothing is written', () => {
      // Deliberate, not an oversight: playlists persist and the queue does not.
      // The module takes no storage at all, so there is no persistence to get
      // wrong — a restart is modelled here by building a second queue.
      const first = createUpNextQueue()
      first.enqueue([track(1), track(2)])
      expect(first.count.value).toBe(2)

      const afterRestart = createUpNextQueue()
      expect(afterRestart.entries.value).toEqual([])
      expect(afterRestart.isEmpty.value).toBe(true)
      expect(afterRestart.head()).toBeNull()
    })

    it('rule 6: shuffle never reorders the queue', () => {
      // Shuffle permutes what a `PlayOrder` position names, which is a layer
      // below this one — `chooseSuccessor` reaches the order only when the
      // queue is empty, so no permutation can be applied to these rows.
      const queue = createUpNextQueue()
      queue.enqueue([track(1), track(2), track(3)])
      const before = ids(queue.entries.value)

      // Every position of a hypothetical permutation, asked in turn.
      for (const index of [7, 2, 5, 0, 9]) {
        const successor = successorOf({ from: orderPosition(index), head: queue.head() })
        expect(successor?.kind).toBe('queue')
        expect(ids(queue.entries.value)).toEqual(before)
      }
      expect(queue.head()?.trackId).toBe(1)
    })

    it('rule 7: repeat-one overrides the queue at a boundary, and repeat-all wraps the order while the queue still wins', () => {
      const queue = createUpNextQueue()
      const [queued] = queue.enqueue([track(77)])
      const last = orderPosition(9)

      // "Repeat-one overrides everything" — including a non-empty queue, and
      // without consuming it. Only at a boundary: an explicit Next moves on,
      // and moving on means the queue head.
      expect(successorOf({ from: last, head: queue.head(), repeat: 'one' })).toEqual({
        kind: 'again',
        position: last
      })
      expect(queue.count.value).toBe(1)
      expect(
        successorOf({
          from: last,
          head: queue.head(),
          repeat: 'one',
          reason: 'explicit',
          total: 10
        })
      ).toMatchObject({ kind: 'queue', entry: queued })

      // Repeat-all wraps the playing playlist at its last row — but only once
      // the queue has nothing to say. The queue takes priority over the wrap.
      expect(
        successorOf({ from: last, head: queue.head(), repeat: 'all', total: 10 })
      ).toMatchObject({ kind: 'queue' })
      queue.take(queued?.id ?? '')
      expect(successorOf({ from: last, head: null, repeat: 'all', total: 10 })).toEqual({
        kind: 'order',
        position: orderPosition(0)
      })

      // And repeat-one under a queue track repeats that track rather than
      // resolving the anchor row, which is what `again` exists to say.
      const detour: SlotPosition = { index: 4, queueEntryId: 'q1' }
      expect(successorOf({ from: detour, repeat: 'one' })).toEqual({
        kind: 'again',
        position: detour
      })
    })
  })

  describe('the length query', () => {
    it('is skipped whenever the queue or repeat-one has already settled the answer', () => {
      const [head] = createUpNextQueue().enqueue([track(1)])

      expect(successorNeedsTotal(null, 'off', 'boundary')).toBe(false)
      expect(successorNeedsTotal(null, 'all', 'boundary')).toBe(true)
      // A queue head wins outright, so nobody has to ask how long the playing
      // playlist is to find that out.
      expect(successorNeedsTotal(head ?? null, 'all', 'boundary')).toBe(false)
      expect(successorNeedsTotal(head ?? null, 'all', 'explicit')).toBe(false)
      expect(successorNeedsTotal(null, 'one', 'boundary')).toBe(false)
      expect(successorNeedsTotal(null, 'one', 'explicit')).toBe(true)
    })

    it('degrades an unknown length to not wrapping rather than to a guess', () => {
      // Both of these name a position past the last row, which `PlayOrder.at()`
      // answers with `null` — the clean stop that was there before repeat
      // existed. What an unknown length must never do is restart a 100k-row
      // library from the top, which is what wrapping without one would be.
      expect(successorOf({ from: orderPosition(9), repeat: 'all', total: null })).toEqual({
        kind: 'order',
        position: orderPosition(10)
      })
      expect(successorOf({ from: orderPosition(9), repeat: 'off', total: 10 })).toEqual({
        kind: 'order',
        position: orderPosition(10)
      })
      // With the length in hand, repeat-all wraps and repeat-off stops.
      expect(
        chooseSuccessor({
          from: orderPosition(9),
          head: null,
          total: 10,
          repeat: 'off',
          reason: 'boundary'
        })
      ).toBeNull()
    })
  })

  describe('position identity', () => {
    it('distinguishes a queue detour from the row it was taken from', () => {
      expect(samePosition(orderPosition(4), orderPosition(4))).toBe(true)
      expect(samePosition(orderPosition(4), { index: 4, queueEntryId: 'q1' })).toBe(false)
      expect(samePosition({ index: 4, queueEntryId: 'q1' }, { index: 4, queueEntryId: 'q2' })).toBe(
        false
      )
      expect(samePosition(null, null)).toBe(true)
      expect(samePosition(null, orderPosition(0))).toBe(false)
    })
  })
})
