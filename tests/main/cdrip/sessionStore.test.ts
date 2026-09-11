import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { OscineError } from '@shared/errors'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import {
  RIP_SESSION_CAP,
  RIP_SESSION_MAX_AGE_MS,
  RipSessionStore,
  type RipSessionCreate
} from '../../../src/main/cdrip/sessionStore'

function memoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db, MIGRATIONS)
  return db
}

function tracks(count: number): RipSessionCreate['tracks'] {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    title: `Track ${i + 1}`,
    artist: 'Artist',
    relPath: `Album/${String(i + 1).padStart(2, '0')} Track ${i + 1}.flac`
  }))
}

function input(over: Partial<RipSessionCreate> = {}): RipSessionCreate {
  return {
    discId: 'disc-id',
    tocHash: 'toc-hash',
    releaseMbid: null,
    rootId: 1,
    relDir: 'Incoming',
    template: '{track:02} {title}',
    album: 'Album',
    albumArtist: 'Artist',
    year: 2000,
    verify: false,
    tracks: tracks(12),
    ...over
  }
}

describe('RipSessionStore', () => {
  let db: Database.Database | undefined
  afterEach(() => {
    db?.close()
  })

  it('persists pending tracks with root-relative POSIX paths before any work', () => {
    db = memoryDb()
    const store = new RipSessionStore(db)
    const id = store.create(input())
    const session = store.load(id)
    expect(session.state).toBe('running')
    expect(session.tracks).toHaveLength(12)
    expect(session.tracks.every((track) => track.status === 'pending')).toBe(true)
    expect(session.tracks.every((track) => track.attempts === 0)).toBe(true)
    expect(session.relDir).toBe('Incoming')
    for (const track of session.tracks) {
      expect(track.relPath.startsWith('/')).toBe(false)
      expect(track.relPath).not.toMatch(/^[a-zA-Z]:/)
      expect(track.relPath.includes(String.fromCharCode(0x5c))).toBe(false)
    }
  })

  it('refuses an absolute path', () => {
    db = memoryDb()
    const store = new RipSessionStore(db)
    expect(() =>
      store.create(
        input({ tracks: [{ number: 1, title: 'A', artist: 'B', relPath: '/abs/a.flac' }] })
      )
    ).toThrow(OscineError)
  })

  it('offers the running session and skips it after dismiss', () => {
    db = memoryDb()
    const store = new RipSessionStore(db)
    const id = store.create(input({ album: 'Kid A' }))
    expect(store.unfinished()).toMatchObject({
      sessionId: id,
      album: 'Kid A',
      total: 12,
      remaining: 12,
      written: 0
    })
    store.beginTrack(id, 1)
    store.recordOutcome(id, {
      trackNumber: 1,
      status: 'written',
      relPath: 'Incoming/01 Track 1.flac'
    })
    expect(store.unfinished()?.remaining).toBe(11)
    expect(store.unfinished()?.written).toBe(1)
    store.dismiss(id)
    expect(store.unfinished()).toBeNull()
    expect(store.load(id).state).toBe('cancelled')
  })

  it('prunes old finished sessions and leaves the running one alone', () => {
    let now = 1_000
    db = memoryDb()
    const store = new RipSessionStore(db, () => now)

    const oldComplete = store.create(input({ album: 'Old', tocHash: 'old' }))
    store.setState(oldComplete, 'complete')

    now = 2_000
    const running = store.create(input({ album: 'Now', tocHash: 'now' }))

    now = 1_000 + RIP_SESSION_MAX_AGE_MS + 1
    store.prune()

    expect(() => store.load(oldComplete)).toThrow(OscineError)
    expect(store.load(running).state).toBe('running')
    expect(store.unfinished()?.sessionId).toBe(running)
  })

  it('caps finished sessions and never deletes a running row to make room', () => {
    let now = 0
    db = memoryDb()
    const store = new RipSessionStore(db, () => now)

    for (let i = 0; i < RIP_SESSION_CAP + 1; i++) {
      now = i + 1
      const id = store.create(input({ tocHash: `h-${i}`, album: `A${i}` }))
      store.setState(id, 'complete')
    }
    now = RIP_SESSION_CAP + 2
    const running = store.create(input({ tocHash: 'running', album: 'Live' }))
    store.prune()

    const count = (db.prepare('SELECT count(*) AS n FROM rip_sessions').get() as { n: number }).n
    expect(count).toBe(RIP_SESSION_CAP)
    expect(store.load(running).state).toBe('running')
  })
})
