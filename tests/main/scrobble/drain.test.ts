import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import {
  SCROBBLE_BACKOFF_BASE_MS,
  SCROBBLE_BACKOFF_MAX_MS
} from '../../../src/main/scrobble/backoff'
import {
  createScrobbleDrainWorker,
  type ScrobbleDrainWorker
} from '../../../src/main/scrobble/drain'
import { ScrobbleOutbox, type ScrobbleQueueEntry } from '../../../src/main/scrobble/outbox'
import { createStubScrobbleTarget } from '../../../src/main/scrobble/stubTarget'
import { netFailed, netOk } from '../../../src/shared/net'
import type { ScrobblePayload, ScrobbleTarget } from '../../../src/shared/scrobble'

let dir: string
let db: Database.Database
let outbox: ScrobbleOutbox
/** UTC ms, moved by hand so backoff is asserted rather than waited for. */
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-drain-'))
  db = openDatabase(join(dir, 'library.db')).db
  outbox = new ScrobbleOutbox(db)
  clock = 1_700_000_000_000
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function payload(overrides: Partial<ScrobblePayload> = {}): ScrobblePayload {
  return {
    artistName: 'Talk Talk',
    title: 'I Believe In You',
    albumTitle: 'Spirit Of Eden',
    albumArtistName: null,
    durationSeconds: 488,
    timestamp: 1_700_000_000,
    ...overrides
  }
}

function enqueue(overrides: Partial<ScrobbleQueueEntry> = {}): number {
  return outbox.enqueue({
    target: 'lastfm',
    kind: 'scrobble',
    listenId: null,
    trackId: null,
    payload: payload(),
    ...overrides
  })
}

/** `random: () => 1` puts jitter at the top of its window, so delays are exact. */
function worker(targets: readonly ScrobbleTarget[]): ScrobbleDrainWorker {
  return createScrobbleDrainWorker({
    outbox,
    targets: () => targets,
    now: () => clock,
    random: () => 1
  })
}

function rows(target: 'lastfm' | 'listenbrainz' = 'lastfm'): ReturnType<ScrobbleOutbox['ready']> {
  return outbox.ready({
    target,
    kinds: ['scrobble', 'love', 'unlove'],
    limit: 1_000,
    now: Number.MAX_SAFE_INTEGER
  })
}

describe('the drain worker, sending', () => {
  it('sends everything due and leaves an empty table behind', async () => {
    const target = createStubScrobbleTarget()
    for (let index = 0; index < 5; index += 1) {
      enqueue({ payload: payload({ timestamp: 1_700_000_000 + index }) })
    }

    const report = await worker([target]).wake()

    expect(report.targets).toEqual([
      { target: 'lastfm', sent: 5, dropped: [], deferred: 0, stop: 'drained' }
    ])
    expect(outbox.depth()).toBe(0)
  })

  it('batches to the target it was handed, not to a number it remembered', async () => {
    // The stub's limit is 3, not Last.fm's 50, precisely so a worker that had
    // learned one target's shape fails here rather than in W11-8.
    const target = createStubScrobbleTarget()
    expect(target.capabilities.batchLimit).toBe(3)

    for (let index = 0; index < 7; index += 1) enqueue()

    await worker([target]).wake()

    expect(target.calls.submitted.map((batch) => batch.length)).toEqual([3, 3, 1])
  })

  it('replays a week offline in the order it happened', async () => {
    const target = createStubScrobbleTarget()
    const week = 7 * 24 * 60 * 60
    const timestamps = Array.from({ length: 20 }, (_, index) => 1_700_000_000 + index * (week / 20))

    // Written in an order nothing would sort into: the row ids and the listen
    // times disagree, which is what a merge or a retry leaves behind.
    for (const timestamp of [...timestamps].reverse()) enqueue({ payload: payload({ timestamp }) })

    await worker([target]).wake()

    const sent = target.calls.submitted.flat().map((item) => item.payload.timestamp)
    expect(sent).toEqual(timestamps)
  })

  it('skips a target that is not connected without opening anything', async () => {
    // The overwhelmingly common case is an operator who has never signed in.
    const target = createStubScrobbleTarget({ connected: false })
    enqueue()

    const report = await worker([target]).wake()

    expect(report.targets[0].stop).toBe('disconnected')
    expect(target.calls.submitted).toEqual([])
    expect(outbox.depth()).toBe(1)
  })

  it('drains two targets independently', async () => {
    const lastfm = createStubScrobbleTarget({ id: 'lastfm' })
    const listenbrainz = createStubScrobbleTarget({
      id: 'listenbrainz',
      capabilities: { batchLimit: 1000 }
    })

    lastfm.queueSubmit(() => netFailed({ kind: 'offline', message: 'No route to host.' }))
    enqueue({ target: 'lastfm' })
    enqueue({ target: 'listenbrainz' })

    const report = await worker([lastfm, listenbrainz]).wake()

    // One target having a bad afternoon must not hold the other's scrobbles.
    expect(report.targets.map((entry) => [entry.target, entry.stop])).toEqual([
      ['lastfm', 'deferred'],
      ['listenbrainz', 'drained']
    ])
    expect(outbox.depth('lastfm')).toBe(1)
    expect(outbox.depth('listenbrainz')).toBe(0)
  })
})

describe('the drain worker, per-item results', () => {
  it('deletes what was accepted and drops what was refused, with its reason', async () => {
    const target = createStubScrobbleTarget()
    const ids = [enqueue(), enqueue(), enqueue()]

    target.queueSubmit((batch) =>
      netOk(
        batch.map((item) =>
          item.id === ids[1]
            ? { id: item.id, accepted: false as const, reason: 'Track not indexable.' }
            : { id: item.id, accepted: true as const }
        )
      )
    )

    const report = await worker([target]).wake()

    expect(report.targets[0].sent).toBe(2)
    expect(report.targets[0].dropped).toEqual([
      { id: ids[1], target: 'lastfm', kind: 'scrobble', reason: 'Track not indexable.' }
    ])
    // A refusal is terminal for the row. Keeping it would be an outbox that
    // never drains; the reason travels on the report because the row that would
    // have carried it is the row being deleted.
    expect(outbox.depth()).toBe(0)
  })

  it('does not let a partial accept retry the accepted half', async () => {
    const target = createStubScrobbleTarget()
    const ids = [enqueue(), enqueue(), enqueue()]

    target.queueSubmit((batch) =>
      netOk(
        batch
          .filter((item) => item.id !== ids[2])
          .map((item) => ({ id: item.id, accepted: true as const }))
      )
    )

    await worker([target]).wake()

    // Exactly the unanswered row is left, backing off. Treating the whole batch
    // as failed would resubmit two scrobbles the service already has.
    expect(rows().map((row) => row.id)).toEqual([ids[2]])
    expect(rows()[0].attempts).toBe(1)
    expect(rows()[0].nextAttemptAt).toBe(clock + SCROBBLE_BACKOFF_BASE_MS)
  })

  it('ignores ids it never sent and second answers for ones it did', async () => {
    const target = createStubScrobbleTarget()
    const id = enqueue()

    target.queueSubmit(() =>
      netOk([
        { id, accepted: true as const },
        { id, accepted: false as const, reason: 'and also no' },
        { id: 999_999, accepted: false as const, reason: 'never sent' }
      ])
    )

    const report = await worker([target]).wake()

    expect(report.targets[0].sent).toBe(1)
    expect(report.targets[0].dropped).toEqual([])
    expect(outbox.depth()).toBe(0)
  })
})

describe('the drain worker, failure classes', () => {
  it('backs a retryable failure off and stops the pass', async () => {
    const target = createStubScrobbleTarget()
    for (let index = 0; index < 6; index += 1) enqueue()

    target.queueSubmit(() =>
      netFailed({ kind: 'unavailable', message: 'The service is having a bad day.', status: 503 })
    )

    const report = await worker([target]).wake()

    expect(report.targets[0]).toMatchObject({ sent: 0, deferred: 3, stop: 'deferred' })
    // Stopped after the first batch: the next one fails identically, and
    // hammering it is how a rate limit becomes a longer one.
    expect(target.calls.submitted).toHaveLength(1)
    expect(outbox.depth()).toBe(6)
    expect(rows().filter((row) => row.attempts === 1)).toHaveLength(3)
    expect(rows().filter((row) => row.attempts === 0)).toHaveLength(3)
  })

  it('grows the delay across passes and stops growing at the ceiling', async () => {
    const target = createStubScrobbleTarget()
    enqueue()

    const drain = worker([target])
    const delays: number[] = []

    for (let pass = 0; pass < 12; pass += 1) {
      target.queueSubmit(() => netFailed({ kind: 'offline', message: 'No route to host.' }))
      await drain.wake()
      const [row] = rows()
      delays.push(row.nextAttemptAt - clock)
      // Jump to the moment the row becomes due again.
      clock = row.nextAttemptAt
    }

    expect(delays[0]).toBe(SCROBBLE_BACKOFF_BASE_MS)
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1])
      expect(delays[index]).toBeLessThanOrEqual(SCROBBLE_BACKOFF_MAX_MS)
    }
    expect(delays.at(-1)).toBe(SCROBBLE_BACKOFF_MAX_MS)
    // Never given up on: a scrobble is worth keeping across a fortnight away.
    expect(outbox.depth()).toBe(1)
  })

  it('honours a Retry-After the service named', async () => {
    const target = createStubScrobbleTarget()
    enqueue()

    target.queueSubmit(() =>
      netFailed({ kind: 'rate-limited', message: 'Slow down.', retryAfterSeconds: 900 })
    )

    await worker([target]).wake()

    expect(rows()[0].nextAttemptAt).toBe(clock + 900_000)
  })

  it('halts on a refused credential without burning an attempt on every row', async () => {
    const target = createStubScrobbleTarget()
    for (let index = 0; index < 6; index += 1) enqueue()

    // What a real target does when its session key is refused: it stands itself
    // down before returning, so the worker needs no knowledge of code 9.
    target.queueSubmit(() => {
      target.setConnected(false)
      return netFailed({ kind: 'rejected', message: 'Last.fm refused the session.', status: 403 })
    })

    const report = await worker([target]).wake()

    expect(report.targets[0]).toMatchObject({ sent: 0, deferred: 0, stop: 'disconnected' })
    expect(outbox.depth()).toBe(6)
    // Not one attempt spent: the operator is the only one who can clear this,
    // and backing off would have every row a day out by the time they do.
    expect(rows().every((row) => row.attempts === 0)).toBe(true)
    expect(rows().every((row) => row.nextAttemptAt === 0)).toBe(true)
    expect(outbox.lastError('lastfm')).toBe('Last.fm refused the session.')
    expect(target.calls.submitted).toHaveLength(1)
  })

  it('loses nothing when the scope is cancelled mid-drain', async () => {
    const target = createStubScrobbleTarget()
    for (let index = 0; index < 6; index += 1) enqueue()

    target.queueSubmit(() =>
      netFailed({ kind: 'cancelled', message: 'The scrobble scope was closed.' })
    )

    const report = await worker([target]).wake()

    expect(report.targets[0].stop).toBe('cancelled')
    // An abandoned drain costs a retry, never a scrobble: the rows are exactly
    // as they were, so the next wake finds the queue untouched.
    expect(outbox.depth()).toBe(6)
    expect(rows().every((row) => row.attempts === 0)).toBe(true)
    expect(rows().every((row) => row.nextAttemptAt === 0)).toBe(true)
    expect(rows().every((row) => row.lastError === null)).toBe(true)
  })

  it('treats withheld consent the same as cancellation', async () => {
    const target = createStubScrobbleTarget()
    enqueue()

    target.queueSubmit(() => netFailed({ kind: 'declined', message: 'No socket was opened.' }))

    const report = await worker([target]).wake()

    expect(report.targets[0].stop).toBe('cancelled')
    expect(rows()[0].attempts).toBe(0)
  })

  it('reports a thrown error against the target that threw and carries on', async () => {
    const broken: ScrobbleTarget = {
      ...createStubScrobbleTarget({ id: 'lastfm' }),
      submit: async () => {
        throw new Error('the statement was broken')
      }
    }
    const working = createStubScrobbleTarget({ id: 'listenbrainz' })

    enqueue({ target: 'lastfm' })
    enqueue({ target: 'listenbrainz' })

    const report = await worker([broken, working]).wake()

    expect(report.targets[0].stop).toBe('errored')
    expect(report.targets[1].stop).toBe('drained')
    expect(outbox.depth('listenbrainz')).toBe(0)
  })
})

describe('the drain worker, loves', () => {
  it('sends loves one at a time and in the order they were made', async () => {
    const target = createStubScrobbleTarget()

    // Heart, un-heart, heart again. Arriving in any other order settles the
    // account in the wrong state.
    enqueue({ kind: 'love', payload: payload({ timestamp: 1_700_000_001 }) })
    enqueue({ kind: 'unlove', payload: payload({ timestamp: 1_700_000_002 }) })
    enqueue({ kind: 'love', payload: payload({ timestamp: 1_700_000_003 }) })

    await worker([target]).wake()

    expect(target.calls.loved).toHaveLength(2)
    expect(target.calls.unloved).toHaveLength(1)
    expect(outbox.depth()).toBe(0)
  })

  it('stops the love stream at the first failure rather than skipping ahead', async () => {
    const target = createStubScrobbleTarget()
    const ids = [
      enqueue({ kind: 'love', payload: payload({ timestamp: 1_700_000_001 }) }),
      enqueue({ kind: 'unlove', payload: payload({ timestamp: 1_700_000_002 }) }),
      enqueue({ kind: 'love', payload: payload({ timestamp: 1_700_000_003 }) })
    ]

    target.queueUnlove(() => netFailed({ kind: 'offline', message: 'No route to host.' }))

    const report = await worker([target]).wake()

    expect(report.targets[0].stop).toBe('deferred')
    expect(target.calls.loved).toHaveLength(1)
    // The later love is untouched. Sending it now would put the un-heart last.
    expect(rows().map((row) => row.id)).toEqual([ids[1], ids[2]])
    expect(rows()[1].attempts).toBe(0)
  })

  it('sends the payload a love is keyed by, and nothing more', async () => {
    const target = createStubScrobbleTarget()
    enqueue({ kind: 'love' })

    await worker([target]).wake()

    expect(target.calls.loved).toEqual([{ artistName: 'Talk Talk', title: 'I Believe In You' }])
  })

  it('drops loves queued for a target that has none', async () => {
    // W11-6 checks `supportsLove` before enqueueing. If a row gets here anyway
    // it can never drain, which is the exact failure this card exists to stop.
    const target = createStubScrobbleTarget({
      id: 'listenbrainz',
      capabilities: { supportsLove: false }
    })
    enqueue({ target: 'listenbrainz', kind: 'love' })

    const report = await worker([target]).wake()

    expect(report.targets[0].dropped).toHaveLength(1)
    expect(target.calls.loved).toEqual([])
    expect(outbox.depth()).toBe(0)
  })

  it('does not attempt loves when the scrobbles could not be sent', async () => {
    const target = createStubScrobbleTarget()
    enqueue({ kind: 'scrobble' })
    enqueue({ kind: 'love' })

    target.queueSubmit(() => netFailed({ kind: 'offline', message: 'No route to host.' }))

    await worker([target]).wake()

    expect(target.calls.loved).toEqual([])
    expect(outbox.depth()).toBe(2)
  })
})

describe('the drain worker, waking', () => {
  it('coalesces a wake arriving mid-pass into exactly one more pass', async () => {
    const target = createStubScrobbleTarget()
    const drain = worker([target])
    enqueue()

    const first = drain.wake()
    // Committed while the first pass is already in flight — the ordinary case
    // of a listen finishing during a drain.
    enqueue()
    const second = drain.wake()

    expect(await first).toBe(await second)
    // Two passes, not two queued drains per wake, and nothing left behind.
    expect(target.calls.submitted).toHaveLength(2)
    expect(outbox.depth()).toBe(0)
  })

  it('starts and stops its timer without keeping anything alive', () => {
    const drain = createScrobbleDrainWorker({
      outbox,
      targets: () => [],
      intervalMs: 60_000
    })

    expect(() => {
      drain.start()
      drain.start()
      drain.stop()
      drain.stop()
    }).not.toThrow()
  })
})
