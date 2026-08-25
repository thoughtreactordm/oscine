import { describe, expect, it } from 'vitest'
import {
  buildUpNextRows,
  createQueueReorder,
  queueDestination,
  TIER_LABEL
} from '../../../src/renderer/panels/tunedeck/upNextRows'
import { createUpNextQueue, type QueueEntry } from '../../../src/renderer/playback/upNextQueue'
import type { Track } from '../../../src/shared/library'

/**
 * The up-next pane's arithmetic, driven against the **real** queue rather than a
 * fixture of one wherever the claim is about the two composing. The rows the
 * pane draws and the indices `move` splices are the same numbers, and a test
 * that invented its own entries would only prove they agree with each other.
 */

function track(id: number, title: string): Track {
  return {
    id,
    rootId: 1,
    title,
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
    artwork: { small: 'oscine://artwork/missing/small', large: 'oscine://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

function stocked(user: number, session: number) {
  const queue = createUpNextQueue()
  if (user > 0) {
    queue.enqueue(Array.from({ length: user }, (_, at) => track(at + 1, `User ${at + 1}`)))
  }
  if (session > 0) {
    queue.fillSession(
      Array.from({ length: session }, (_, at) => ({
        track: track(100 + at, `Session ${at + 1}`),
        orderIndex: at
      }))
    )
  }
  return queue
}

function ids(entries: readonly QueueEntry[]): string[] {
  return entries.map((entry) => entry.id)
}

describe('the up-next rows', () => {
  it('labels each tier once and counts only its own', () => {
    const rows = buildUpNextRows(stocked(2, 3).entries.value)

    const headers = rows.filter((row) => row.kind === 'header')
    expect(headers.map((row) => row.label)).toEqual([TIER_LABEL.user, TIER_LABEL.session])
    expect(headers.map((row) => row.count)).toEqual([2, 3])
    // Two labels plus five entries: the labels are rows, which is what keeps
    // one set of virtualization arithmetic over both tiers.
    expect(rows).toHaveLength(7)
  })

  it('draws no label for a tier that is empty', () => {
    expect(buildUpNextRows(stocked(0, 2).entries.value).filter((r) => r.kind === 'header')).toEqual(
      [expect.objectContaining({ label: TIER_LABEL.session, count: 2 })]
    )
    expect(buildUpNextRows([])).toEqual([])
  })

  it('numbers entries within their own tier but indexes them globally', () => {
    const rows = buildUpNextRows(stocked(2, 2).entries.value).filter((row) => row.kind === 'entry')

    // What the operator counts is "the third of the ones I queued"...
    expect(rows.map((row) => row.position)).toEqual([1, 2, 1, 2])
    // ...and what `move` splices is the index into the queue as a whole. A pane
    // that handed the tier-local number to `move` would clamp every session
    // drag back to the top of the session tier.
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3])
  })

  it('marks only the head as next — §5 rule 1, first arm', () => {
    const rows = buildUpNextRows(stocked(2, 2).entries.value).filter((row) => row.kind === 'entry')
    expect(rows.map((row) => row.isNext)).toEqual([true, false, false, false])
  })

  it('marks the session head as next when nothing is hand-queued', () => {
    const rows = buildUpNextRows(stocked(0, 2).entries.value).filter((row) => row.kind === 'entry')
    expect(rows[0]?.isNext).toBe(true)
  })

  it('points each label at the first entry of the tier it labels', () => {
    // A label is 36 pixels a drag can be over, and "just above the first row of
    // this tier" is where a hand aims to put something at the top of one. The
    // pane resolves a drag over a label to `firstId`, so a band of the list
    // that would otherwise do nothing does the obvious thing instead.
    const entries = stocked(2, 3).entries.value
    const headers = buildUpNextRows(entries).filter((row) => row.kind === 'header')

    expect(headers.map((row) => row.firstId)).toEqual([entries[0]!.id, entries[2]!.id])
  })
})

describe('a drop inside the queue', () => {
  it('is an index into the queue with the dragged row already removed', () => {
    const entries = stocked(4, 0).entries.value
    const [a, , c, d] = ids(entries)

    // The first row dropped after the last: the visible insertion point is 4,
    // but `move` splices it out first, so it lands at 3 by then.
    expect(queueDestination(entries, a!, d!, 'after')).toBe(3)
    expect(queueDestination(entries, a!, c!, 'after')).toBe(2)
    expect(queueDestination(entries, d!, a!, 'before')).toBe(0)
  })

  it('refuses a gesture that changes nothing', () => {
    const entries = stocked(3, 0).entries.value
    const [a, b] = ids(entries)

    expect(queueDestination(entries, a!, a!, 'before')).toBeNull()
    expect(queueDestination(entries, a!, a!, 'after')).toBeNull()
    // The gap it already occupies is what "after my previous neighbour" is.
    expect(queueDestination(entries, b!, a!, 'after')).toBeNull()
  })

  it('refuses to cross the tier boundary rather than clamping to it', () => {
    const entries = stocked(2, 2).entries.value
    const [user, , session] = ids(entries)

    // `UpNextQueue.move` clamps, so a drop drawn across the boundary would land
    // somewhere other than where the indicator promised.
    expect(queueDestination(entries, user!, session!, 'after')).toBeNull()
    expect(queueDestination(entries, session!, user!, 'before')).toBeNull()
  })

  it('refuses a row that is no longer in the queue', () => {
    const entries = stocked(2, 0).entries.value
    expect(queueDestination(entries, 'q99', entries[0]!.id, 'before')).toBeNull()
    expect(queueDestination(entries, entries[0]!.id, 'q99', 'before')).toBeNull()
  })
})

describe('the reorder gesture', () => {
  it('moves the row where the indicator said it would, in the real queue', () => {
    const queue = stocked(3, 2)
    const reorder = createQueueReorder(() => queue.entries.value, queue.move)
    const [first, , third] = ids(queue.entries.value)

    reorder.begin(first!)
    expect(reorder.over(third!, 'after')).toBe(true)
    expect(reorder.indicator(third!)).toBe('after')
    reorder.drop()

    expect(queue.entries.value.map((entry) => entry.track.title)).toEqual([
      'User 2',
      'User 3',
      'User 1',
      'Session 1',
      'Session 2'
    ])
  })

  it('shows no indicator where a drop would refuse, and still claims the drag', () => {
    const queue = stocked(2, 2)
    const reorder = createQueueReorder(() => queue.entries.value, queue.move)
    const [user, , session] = ids(queue.entries.value)
    const before = ids(queue.entries.value)

    reorder.begin(user!)
    // Claimed — this pane started it — but the boundary refuses, so nothing is
    // promised and nothing moves.
    expect(reorder.over(session!, 'before')).toBe(true)
    expect(reorder.indicator(session!)).toBeNull()
    reorder.drop()

    expect(ids(queue.entries.value)).toEqual(before)
  })

  it('lands a row at the top of its tier when dropped on that tier label', () => {
    // What the pane does with a label: resolve it to its `firstId` and a
    // `before`. Asserted through the drag model rather than by reading the
    // header, because the claim is that the gesture completes.
    const queue = stocked(1, 3)
    const rows = buildUpNextRows(queue.entries.value)
    const sessionLabel = rows
      .filter((row) => row.kind === 'header')
      .find((row) => row.origin === 'session')!
    const last = queue.sessionEntries.value[2]!

    const reorder = createQueueReorder(() => queue.entries.value, queue.move)
    reorder.begin(last.id)
    expect(reorder.over(sessionLabel.firstId, 'before')).toBe(true)
    reorder.drop()

    expect(queue.sessionEntries.value.map((entry) => entry.track.title)).toEqual([
      'Session 3',
      'Session 1',
      'Session 2'
    ])
  })

  it('does not claim a drag this pane did not start', () => {
    const queue = stocked(2, 0)
    const reorder = createQueueReorder(() => queue.entries.value, queue.move)
    // A track selection dragged in from the library has to fall through to
    // whatever is listening for it rather than be read as a reorder.
    expect(reorder.over(queue.entries.value[0]!.id, 'before')).toBe(false)
  })

  it('drops nothing after the gesture is abandoned', () => {
    const queue = stocked(3, 0)
    const reorder = createQueueReorder(() => queue.entries.value, queue.move)
    const [first, , third] = ids(queue.entries.value)
    const before = ids(queue.entries.value)

    reorder.begin(first!)
    reorder.over(third!, 'after')
    reorder.end()
    reorder.drop()

    expect(ids(queue.entries.value)).toEqual(before)
    expect(reorder.dragId.value).toBeNull()
  })

  it('drops nothing when the dragged row was removed mid-gesture', () => {
    const queue = stocked(3, 0)
    const reorder = createQueueReorder(() => queue.entries.value, queue.move)
    const [first, , third] = ids(queue.entries.value)

    reorder.begin(first!)
    reorder.over(third!, 'after')
    queue.remove(first!)
    reorder.drop()

    expect(queue.entries.value.map((entry) => entry.track.title)).toEqual(['User 2', 'User 3'])
  })
})

describe('the row the pane never draws', () => {
  /**
   * §5 rule 1's shift happens when the advance commits, so by the time anything
   * is audible its entry is out of the queue. That is what "removing the
   * currently-playing entry" resolves to here: there is no such row to remove,
   * and the pane cannot offer a gesture that gets it wrong.
   */
  it('is the one that is playing — the shift took it before the pane saw it', () => {
    const queue = stocked(2, 0)
    const head = queue.head()!

    queue.take(head.id)

    expect(queue.entry(head.id)).toBeNull()
    const drawn = buildUpNextRows(queue.entries.value).filter((row) => row.kind === 'entry')
    expect(drawn.map((row) => row.entry.id)).not.toContain(head.id)
    // And what is left renumbers from one, so the next row is next.
    expect(drawn.map((row) => row.position)).toEqual([1])
    expect(drawn[0]?.isNext).toBe(true)
  })

  it('is every session row a jump passed over, and the user tier survives it', () => {
    const queue = stocked(1, 3)
    const third = queue.sessionEntries.value[2]!

    // A session entry is an order row, so jumping to it leaves the rows above
    // it behind; a user row is a detour and is not "behind" anything.
    queue.takeThrough(third.id)

    const rows = buildUpNextRows(queue.entries.value)
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.label)).toEqual([
      TIER_LABEL.user
    ])
    expect(rows.filter((row) => row.kind === 'entry').map((row) => row.entry.track.title)).toEqual([
      'User 1'
    ])
  })

  it('removing an ordinary row leaves the rest numbered without a gap', () => {
    const queue = stocked(3, 0)
    const [, second] = ids(queue.entries.value)

    expect(queue.remove(second!)).toBe(true)

    const drawn = buildUpNextRows(queue.entries.value).filter((row) => row.kind === 'entry')
    expect(drawn.map((row) => row.position)).toEqual([1, 2])
    expect(drawn.map((row) => row.index)).toEqual([0, 1])
    expect(drawn.map((row) => row.entry.track.title)).toEqual(['User 1', 'User 3'])
  })
})
