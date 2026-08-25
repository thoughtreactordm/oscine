import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import {
  ScrobbleOutbox,
  UnsendableScrobbleError,
  scrobbleEnqueueRejection,
  type ScrobbleQueueEntry
} from '../../../src/main/scrobble/outbox'
import type { ScrobblePayload, ScrobbleTargetCapabilities } from '../../../src/shared/scrobble'

let dir: string
let db: Database.Database
let outbox: ScrobbleOutbox

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-outbox-'))
  db = openDatabase(join(dir, 'library.db')).db
  outbox = new ScrobbleOutbox(db)
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

function entry(overrides: Partial<ScrobbleQueueEntry> = {}): ScrobbleQueueEntry {
  return {
    target: 'lastfm',
    kind: 'scrobble',
    listenId: null,
    trackId: null,
    payload: payload(),
    ...overrides
  }
}

const capabilities = (
  overrides: Partial<ScrobbleTargetCapabilities> = {}
): ScrobbleTargetCapabilities => ({
  batchLimit: 3,
  supportsLove: true,
  requiresDuration: false,
  ...overrides
})

describe('scrobbleEnqueueRejection', () => {
  it('accepts an ordinary listen', () => {
    expect(scrobbleEnqueueRejection(entry(), capabilities())).toBeNull()
  })

  it('refuses a listen with no artist, which no service will index', () => {
    expect(scrobbleEnqueueRejection(entry({ payload: payload({ artistName: '' }) }))).toMatch(
      /artist/i
    )
    // A tag holding one space is the same nothing as an empty one.
    expect(scrobbleEnqueueRejection(entry({ payload: payload({ artistName: '   ' }) }))).toMatch(
      /artist/i
    )
  })

  it('refuses a listen with no title', () => {
    expect(scrobbleEnqueueRejection(entry({ payload: payload({ title: ' ' }) }))).toMatch(/title/i)
  })

  it('refuses a listen with no usable timestamp', () => {
    expect(scrobbleEnqueueRejection(entry({ payload: payload({ timestamp: 0 }) }))).not.toBeNull()
  })

  it('refuses a listen with no duration only where the target needs one', () => {
    const withoutDuration = entry({ payload: payload({ durationSeconds: null }) })

    // Declared rather than discovered: dropping it here beats submitting it,
    // being rejected, and dropping it a round trip later.
    expect(
      scrobbleEnqueueRejection(withoutDuration, capabilities({ requiresDuration: true }))
    ).not.toBeNull()
    expect(scrobbleEnqueueRejection(withoutDuration, capabilities())).toBeNull()
  })

  it('refuses a love for a target that has none', () => {
    const love = entry({ kind: 'love' })

    expect(scrobbleEnqueueRejection(love, capabilities({ supportsLove: false }))).not.toBeNull()
    expect(scrobbleEnqueueRejection(love, capabilities())).toBeNull()
  })

  it('says nothing about a target it was not given one for', () => {
    // W11-5 asks before opening its transaction, and does not always have a
    // target to hand — an import, a repair path, a test.
    expect(
      scrobbleEnqueueRejection(entry({ payload: payload({ durationSeconds: null }) }))
    ).toBeNull()
  })
})

describe('ScrobbleOutbox.enqueue', () => {
  it('snapshots everything that goes on the wire', () => {
    const id = outbox.enqueue(
      entry({
        listenId: 42,
        trackId: 7,
        payload: payload({ albumArtistName: 'Various Artists', timestamp: 1_600_000_000 })
      })
    )

    const [row] = outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 1 })

    expect(row).toEqual({
      id,
      target: 'lastfm',
      kind: 'scrobble',
      listenId: 42,
      trackId: 7,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      payload: payload({ albumArtistName: 'Various Artists', timestamp: 1_600_000_000 })
    })
  })

  it('survives the track it describes being deleted', () => {
    // The whole reason there is no foreign key: the rescan that removed the
    // track and the network coming back are the same afternoon.
    outbox.enqueue(entry({ trackId: 999_999, listenId: 999_999 }))

    expect(outbox.depth('lastfm')).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('throws rather than writing a row that can never drain', () => {
    expect(() => outbox.enqueue(entry({ payload: payload({ artistName: '' }) }))).toThrow(
      UnsendableScrobbleError
    )
    expect(outbox.depth()).toBe(0)
  })

  it('composes with a transaction the caller already opened', () => {
    // W11-5 enqueues inside the transaction that writes the listen. A rollback
    // has to take both, or a listen exists that was never scrobbled.
    expect(() =>
      db.transaction(() => {
        outbox.enqueue(entry())
        throw new Error('the listen insert failed')
      })()
    ).toThrow('the listen insert failed')

    expect(outbox.depth()).toBe(0)
  })
})

describe('ScrobbleOutbox.ready', () => {
  it('returns the oldest listens first, whatever order they were written in', () => {
    // A week offline replays in the order it happened, not in the order SQLite
    // felt like returning.
    for (const timestamp of [1_700_000_300, 1_700_000_100, 1_700_000_200]) {
      outbox.enqueue(entry({ payload: payload({ timestamp }) }))
    }

    const rows = outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 1 })

    expect(rows.map((row) => row.payload.timestamp)).toEqual([
      1_700_000_100, 1_700_000_200, 1_700_000_300
    ])
  })

  it('breaks a timestamp tie by insertion order', () => {
    // Two toggles inside one second. Arriving as unlove-then-love instead of
    // love-then-unlove leaves the account in the wrong state.
    const first = outbox.enqueue(entry({ kind: 'love' }))
    const second = outbox.enqueue(entry({ kind: 'unlove' }))

    const rows = outbox.ready({
      target: 'lastfm',
      kinds: ['love', 'unlove'],
      limit: 10,
      now: 1
    })

    expect(rows.map((row) => row.id)).toEqual([first, second])
  })

  it('separates targets', () => {
    outbox.enqueue(entry({ target: 'lastfm' }))
    outbox.enqueue(entry({ target: 'listenbrainz' }))

    expect(outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 1 })).toHaveLength(
      1
    )
    expect(
      outbox.ready({ target: 'listenbrainz', kinds: ['scrobble'], limit: 10, now: 1 })
    ).toHaveLength(1)
  })

  it('separates kinds, because scrobbles batch and loves do not', () => {
    outbox.enqueue(entry({ kind: 'scrobble' }))
    outbox.enqueue(entry({ kind: 'love' }))
    outbox.enqueue(entry({ kind: 'unlove' }))

    expect(outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 1 })).toHaveLength(
      1
    )
    expect(
      outbox.ready({ target: 'lastfm', kinds: ['love', 'unlove'], limit: 10, now: 1 })
    ).toHaveLength(2)
  })

  it('withholds rows that are still backing off', () => {
    const id = outbox.enqueue(entry())
    outbox.reschedule([{ id, nextAttemptAt: 5_000 }], 'offline')

    expect(outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 4_999 })).toEqual(
      []
    )
    expect(
      outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 5_000 })
    ).toHaveLength(1)
  })

  it('answers nothing for a nonsensical request rather than everything', () => {
    outbox.enqueue(entry())

    expect(outbox.ready({ target: 'lastfm', kinds: [], limit: 10, now: 1 })).toEqual([])
    expect(outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 0, now: 1 })).toEqual([])
  })
})

describe('ScrobbleOutbox bookkeeping', () => {
  it('counts an attempt exactly once per reschedule', () => {
    const id = outbox.enqueue(entry())

    outbox.reschedule([{ id, nextAttemptAt: 100 }], 'offline')
    outbox.reschedule([{ id, nextAttemptAt: 200 }], 'timed out')

    const [row] = outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 200 })
    expect(row.attempts).toBe(2)
    expect(row.nextAttemptAt).toBe(200)
    expect(row.lastError).toBe('timed out')
  })

  it('records an error without charging the row for it', () => {
    // The terminal-for-the-account case: every row would fail identically, and
    // spending an attempt each spends the backoff budget on something only the
    // operator can clear.
    const id = outbox.enqueue(entry())
    outbox.noteError([id], 'The session was refused.')

    const [row] = outbox.ready({ target: 'lastfm', kinds: ['scrobble'], limit: 10, now: 1 })
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt).toBe(0)
    expect(row.lastError).toBe('The session was refused.')
  })

  it('reports depth over everything queued, not just what is due', () => {
    // A row backing off is still a scrobble that has not been sent. Counting
    // only the due ones would make "3 waiting" flicker.
    const id = outbox.enqueue(entry())
    outbox.enqueue(entry({ target: 'listenbrainz' }))
    outbox.reschedule([{ id, nextAttemptAt: Number.MAX_SAFE_INTEGER }], 'offline')

    expect(outbox.depth()).toBe(2)
    expect(outbox.depth('lastfm')).toBe(1)
  })

  it('surfaces the most recent error a target still has rows for', () => {
    const first = outbox.enqueue(entry())
    const second = outbox.enqueue(entry())

    expect(outbox.lastError('lastfm')).toBeNull()

    outbox.reschedule([{ id: first, nextAttemptAt: 1 }], 'offline')
    outbox.reschedule([{ id: second, nextAttemptAt: 1 }], 'rate limited')

    expect(outbox.lastError('lastfm')).toBe('rate limited')
    expect(outbox.lastError('listenbrainz')).toBeNull()
  })

  it('empties on delete, so the steady state is an empty table', () => {
    const ids = [outbox.enqueue(entry()), outbox.enqueue(entry())]

    outbox.delete(ids)

    expect(outbox.depth()).toBe(0)
    expect(outbox.delete([])).toBeUndefined()
  })
})
