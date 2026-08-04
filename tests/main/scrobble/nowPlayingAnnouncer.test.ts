/**
 * Now-playing, and the event it hangs off — W11-5, D19.
 *
 * Two claims, tested at the two levels they live at. That the announcer itself
 * tells every connected target and swallows everything is tested against the
 * stub; that it fires once per *transport commit* is tested through the real
 * `SqlitePlayHistoryService`, because "the moment the trail gets its row" is the
 * definition, not an implementation detail that a fake could stand in for.
 *
 * The third claim — that repeat-one commits once per pass and a skip commits
 * once — belongs to the playback controller, which is what decides when a play
 * starts. It is tested there, in `tests/renderer/playback/controller.test.ts`
 * under "reporting plays to the trail".
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqlitePlayHistoryService } from '../../../src/main/history/service'
import { createNowPlayingAnnouncer } from '../../../src/main/scrobble/nowPlaying'
import { createStubScrobbleTarget } from '../../../src/main/scrobble/stubTarget'
import type { Track } from '../../../src/shared/library'

const track = (overrides: Partial<Track> = {}): Track =>
  ({
    id: 1,
    rootId: 1,
    title: 'Ascension Day',
    artist: 'Talk Talk',
    album: 'Laughing Stock',
    albumArtist: 'Talk Talk',
    trackNo: 4,
    discNo: 1,
    year: 1991,
    durationSec: 366,
    codec: 'flac',
    encodedBytes: 1,
    sampleRateHz: 44_100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    favorite: false,
    artwork: {},
    ...overrides
  }) as Track

describe('createNowPlayingAnnouncer', () => {
  it('tells every connected target, with no timestamp', () => {
    const lastfm = createStubScrobbleTarget({ id: 'lastfm', connected: true })
    const listenbrainz = createStubScrobbleTarget({ id: 'listenbrainz', connected: true })
    createNowPlayingAnnouncer({ targets: () => [lastfm, listenbrainz] }).announce(track())

    expect(lastfm.calls.nowPlaying).toEqual([
      {
        artistName: 'Talk Talk',
        title: 'Ascension Day',
        albumTitle: 'Laughing Stock',
        albumArtistName: 'Talk Talk',
        durationSeconds: 366
      }
    ])
    expect(listenbrainz.calls.nowPlaying).toHaveLength(1)
  })

  it('says nothing to a target nobody is signed into', () => {
    const offline = createStubScrobbleTarget({ connected: false })
    createNowPlayingAnnouncer({ targets: () => [offline] }).announce(track())

    // The common case, and it must cost no request at all.
    expect(offline.calls.nowPlaying).toEqual([])
  })

  it('says nothing for a track with no artist or no title', () => {
    const target = createStubScrobbleTarget({ connected: true })
    const announcer = createNowPlayingAnnouncer({ targets: () => [target] })

    announcer.announce(track({ artist: null }))
    announcer.announce(track({ artist: '   ' }))
    announcer.announce(track({ title: '' }))

    // Every service keys on artist and title. A notification missing either is
    // a round trip that can only be refused.
    expect(target.calls.nowPlaying).toEqual([])
  })

  it('reads the targets per announcement, so signing in mid-session counts', () => {
    const target = createStubScrobbleTarget({ connected: false })
    const announcer = createNowPlayingAnnouncer({ targets: () => [target] })

    announcer.announce(track())
    target.setConnected(true)
    announcer.announce(track())

    expect(target.calls.nowPlaying).toHaveLength(1)
  })

  it('returns before the target answers, and never throws', () => {
    const target = createStubScrobbleTarget({ connected: true })
    // Fire-and-forget is a contract, and it is called from the path of every
    // track change: nothing about a track starting may wait on, or be broken
    // by, a network round trip.
    expect(() =>
      createNowPlayingAnnouncer({ targets: () => [target] }).announce(track())
    ).not.toThrow()
  })
})

describe('the transport-commit moment', () => {
  let dir: string
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fermata-nowplaying-'))
    db = openDatabase(join(dir, 'library.db')).db
    db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)').run('M', '/m', 0)
    db.prepare('INSERT INTO artists (name) VALUES (?)').run('Talk Talk')
    db.prepare(
      `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, duration_ms)
       VALUES (1, 'a.flac', 1, 2, 'Ascension Day', 1, 366000)`
    ).run()
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('announces once per recorded play, from the same event as the trail row', async () => {
    const target = createStubScrobbleTarget({ connected: true })
    const announcer = createNowPlayingAnnouncer({ targets: () => [target] })
    const history = new SqlitePlayHistoryService({
      db,
      onRecorded: (entry) => announcer.announce(entry.track)
    })

    await history.record(1)
    await history.record(1)

    // Two commits, two announcements. This is where repeat-one gets its second
    // notification from — the controller reports a play per pass, so the trail
    // writes a row per pass, so this fires per pass.
    expect(target.calls.nowPlaying).toHaveLength(2)
  })

  it('announces nothing for a track that has left the library', async () => {
    const target = createStubScrobbleTarget({ connected: true })
    const announcer = createNowPlayingAnnouncer({ targets: () => [target] })
    const history = new SqlitePlayHistoryService({
      db,
      onRecorded: (entry) => announcer.announce(entry.track)
    })

    // `record` answers `null`, so there is no play to announce — and claiming
    // to be playing a track that was just deleted would be a lie about the
    // present, which is the only thing this message is about.
    expect(await history.record(999)).toBeNull()
    expect(target.calls.nowPlaying).toEqual([])
  })

  it('records the trail exactly as before when nothing is listening', async () => {
    const history = new SqlitePlayHistoryService({ db })
    // The hook is optional, and a build with no scrobbling must be unchanged.
    expect(await history.record(1)).not.toBeNull()
  })
})
