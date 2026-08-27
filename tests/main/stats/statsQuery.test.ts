import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { StatsStore } from '../../../src/main/stats/store'
import type { StatsRange } from '../../../src/shared/stats'

/**
 * The stats engine's semantics (W10-10).
 *
 * Against a real database through the real migration list, and against rows
 * written straight into `listens` rather than through `ListenStore`. That is
 * deliberate: the commit path can only produce listens of tracks that exist
 * right now, and half of what this engine promises is about the rows it cannot
 * produce — a listen whose track has been deleted, a snapshot that no longer
 * matches the library, two spellings of one artist. Those are ordinary rows in
 * the log and this is how they get written.
 *
 * The scale fixture and the measurement live next door in `statsScale.test.ts`.
 */

let dir: string
let db: Database.Database
let store: StatsStore

let nextPath = 0

/** Everything a listen needs, with the parts most tests do not care about defaulted. */
interface Seed {
  startedAt: number
  msListened?: number
  title?: string
  artist?: string | null
  album?: string | null
  albumArtist?: string | null
  /** `undefined` seeds a real track and links it; `null` writes the deleted-track row. */
  trackId?: number | null
  genres?: string[]
}

function rootId(): number {
  const existing = db.prepare('SELECT id FROM roots LIMIT 1').get() as { id: number } | undefined
  if (existing) return existing.id
  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 0).lastInsertRowid
  )
}

function seedTrack(title = `Song ${nextPath}`): number {
  return Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, duration_ms)
         VALUES (?, ?, 1, 2, ?, 200000)`
      )
      .run(rootId(), `t${nextPath++}.flac`, title).lastInsertRowid
  )
}

function listen(seed: Seed): number {
  const trackId = seed.trackId === undefined ? seedTrack() : seed.trackId
  const id = Number(
    db
      .prepare(
        `INSERT INTO listens
           (track_id, started_at, ms_listened, duration_ms,
            title, artist_name, album_title, album_artist_name)
         VALUES (?, ?, ?, 200000, ?, ?, ?, ?)`
      )
      .run(
        trackId,
        seed.startedAt,
        seed.msListened ?? 60_000,
        seed.title ?? 'Song',
        seed.artist ?? null,
        seed.album ?? null,
        seed.albumArtist ?? null
      ).lastInsertRowid
  )

  const insertGenre = db.prepare(
    'INSERT INTO listen_genres (listen_id, genre_key, genre) VALUES (?, ?, ?)'
  )
  for (const genre of seed.genres ?? []) insertGenre.run(id, genre.toLowerCase(), genre)
  return id
}

/** A range wide enough to hold every fixture below. */
const ALL: StatsRange = { from: 0, to: 10_000_000 }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-stats-'))
  db = openDatabase(join(dir, 'library.db')).db
  store = new StatsStore(db)
  nextPath = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('StatsStore.query — dimensions', () => {
  it('ranks tracks by the snapshot tuple, with both totals', () => {
    listen({ startedAt: 100, title: 'Alpha', artist: 'A', album: 'One', msListened: 60_000 })
    listen({ startedAt: 200, title: 'Alpha', artist: 'A', album: 'One', msListened: 90_000 })
    listen({ startedAt: 300, title: 'Beta', artist: 'A', album: 'One', msListened: 300_000 })

    const result = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    })

    expect(result.total).toBe(2)
    expect(result.rows.map((row) => [row.label, row.listens, row.msListened])).toEqual([
      ['Alpha', 2, 150_000],
      ['Beta', 1, 300_000]
    ])
    expect(result.rows[0]?.sublabel).toBe('A')
  })

  /**
   * The same title on two albums is two rows, and that is the design rather
   * than a rounding error — the snapshot is all the engine has to tell a studio
   * take from a live one, so it keeps them apart.
   */
  it('separates one title across two albums', () => {
    listen({ startedAt: 100, title: 'Alpha', artist: 'A', album: 'Studio' })
    listen({ startedAt: 200, title: 'Alpha', artist: 'A', album: 'Live' })

    const result = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    })
    expect(result.total).toBe(2)
    expect(result.rows.every((row) => row.listens === 1)).toBe(true)
  })

  it('ranks albums by title and album artist, ignoring the track artist', () => {
    listen({ startedAt: 100, title: 'A', artist: 'Guest One', album: 'Comp', albumArtist: null })
    listen({ startedAt: 200, title: 'B', artist: 'Guest Two', album: 'Comp', albumArtist: null })
    listen({ startedAt: 300, title: 'C', artist: 'Solo', album: 'Solo LP', albumArtist: 'Solo' })

    const result = store.query({
      range: ALL,
      dimension: 'album',
      sort: 'listens',
      limit: 10,
      offset: 0
    })

    expect(result.rows.map((row) => [row.label, row.sublabel, row.listens])).toEqual([
      ['Comp', null, 2],
      ['Solo LP', 'Solo', 1]
    ])
  })

  it('ranks artists on the snapshot, so two spellings are two rows', () => {
    listen({ startedAt: 100, title: 'A', artist: 'Bjork' })
    listen({ startedAt: 200, title: 'B', artist: 'Björk' })
    listen({ startedAt: 300, title: 'C', artist: 'Björk' })

    const result = store.query({
      range: ALL,
      dimension: 'artist',
      sort: 'listens',
      limit: 10,
      offset: 0
    })

    expect(result.total).toBe(2)
    expect(result.rows.map((row) => [row.label, row.listens])).toEqual([
      ['Björk', 2],
      ['Bjork', 1]
    ])
    expect(result.rows.every((row) => row.sublabel === null)).toBe(true)
  })

  /**
   * A row with nothing to say about the dimension is left out rather than
   * folded into a nameless group: an untagged listen is not an album anyone
   * listened to, and a top-albums list with a blank row at the top would be a
   * row no click can ever open.
   */
  it('drops rows whose dimension column is null, but keeps them for tracks', () => {
    listen({ startedAt: 100, title: 'Untitled tag', artist: null, album: null })
    listen({ startedAt: 200, title: 'Tagged', artist: 'A', album: 'One' })

    expect(
      store.query({ range: ALL, dimension: 'artist', sort: 'listens', limit: 10, offset: 0 }).total
    ).toBe(1)
    expect(
      store.query({ range: ALL, dimension: 'album', sort: 'listens', limit: 10, offset: 0 }).total
    ).toBe(1)
    expect(
      store.query({ range: ALL, dimension: 'track', sort: 'listens', limit: 10, offset: 0 }).total
    ).toBe(2)
  })

  it('ranks genres through listen_genres, counting a listen once per genre', () => {
    listen({ startedAt: 100, title: 'A', genres: ['Jazz', 'Funk'] })
    listen({ startedAt: 200, title: 'B', genres: ['Jazz'] })
    listen({ startedAt: 300, title: 'C', genres: [] })

    const genres = store.query({
      range: ALL,
      dimension: 'genre',
      sort: 'listens',
      limit: 10,
      offset: 0
    })

    expect(genres.rows.map((row) => [row.key, row.label, row.listens])).toEqual([
      ['jazz', 'Jazz', 2],
      ['funk', 'Funk', 1]
    ])

    // The same three listens are three rows in the log, not four: the multi-genre
    // one is counted once under each of its genres and once overall.
    expect(store.summary({ range: ALL, scope: null }).listens).toBe(3)
  })

  it('groups genres by key across spellings', () => {
    listen({ startedAt: 100, title: 'A', genres: ['IDM'] })
    listen({ startedAt: 200, title: 'B', genres: ['idm'] })

    const genres = store.query({
      range: ALL,
      dimension: 'genre',
      sort: 'listens',
      limit: 10,
      offset: 0
    })
    expect(genres.total).toBe(1)
    expect(genres.rows[0]?.listens).toBe(2)
  })
})

describe('StatsStore.query — the range', () => {
  /**
   * The boundary test the card names. Both ends are in, because `StatsRange` is
   * closed and the renderer computed both from a preset.
   */
  it('includes a listen exactly on from and exactly on to', () => {
    listen({ startedAt: 999, title: 'Before' })
    listen({ startedAt: 1000, title: 'On from' })
    listen({ startedAt: 1500, title: 'Inside' })
    listen({ startedAt: 2000, title: 'On to' })
    listen({ startedAt: 2001, title: 'After' })

    const range: StatsRange = { from: 1000, to: 2000 }
    const result = store.query({
      range,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    })

    expect(result.rows.map((row) => row.label).sort()).toEqual(['Inside', 'On from', 'On to'])
    expect(store.summary({ range: range, scope: null }).listens).toBe(3)
  })

  it('reports an empty range as zeros and nulls rather than as nothing', () => {
    listen({ startedAt: 100, title: 'A' })

    const empty: StatsRange = { from: 500, to: 600 }
    expect(
      store.query({ range: empty, dimension: 'track', sort: 'listens', limit: 10, offset: 0 })
    ).toMatchObject({ rows: [], total: 0 })
    expect(store.summary({ range: empty, scope: null })).toMatchObject({
      listens: 0,
      msListened: 0,
      tracks: 0,
      artists: 0,
      albums: 0,
      firstListenAt: null,
      lastListenAt: null
    })
  })
})

describe('StatsStore.query — the surviving track link', () => {
  it('counts a listen whose track is gone, and reports its trackId as null', () => {
    listen({ startedAt: 100, title: 'Deleted', artist: 'A', trackId: null })
    listen({ startedAt: 200, title: 'Deleted', artist: 'A', trackId: null })

    const result = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.listens).toBe(2)
    expect(result.rows[0]?.trackId).toBeNull()
  })

  it('survives a track deletion: the row stays, the link goes', () => {
    const trackId = seedTrack('Doomed')
    listen({ startedAt: 100, title: 'Doomed', artist: 'A', trackId })

    db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

    const result = store.query({
      range: ALL,
      dimension: 'artist',
      sort: 'listens',
      limit: 10,
      offset: 0
    })
    expect(result.rows).toEqual([
      {
        key: 'A',
        label: 'A',
        sublabel: null,
        listens: 1,
        msListened: 60_000,
        trackId: null,
        artworkHash: null
      }
    ])
  })

  it('links a group to a surviving track when it has one among deleted ones', () => {
    const trackId = seedTrack('Kept')
    listen({ startedAt: 100, title: 'Kept', artist: 'A', trackId: null })
    listen({ startedAt: 200, title: 'Kept', artist: 'A', trackId })

    const result = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    })
    expect(result.rows[0]?.trackId).toBe(trackId)
  })

  it("carries the surviving track's album artwork hash, and null when it has none", () => {
    const albumId = Number(
      db.prepare('INSERT INTO albums (title, artwork_hash) VALUES (?, ?)').run('Rec', 'deadbeef')
        .lastInsertRowid
    )
    const withArt = Number(
      db
        .prepare(
          `INSERT INTO tracks (root_id, rel_path, mtime, size, title, album_id, duration_ms)
           VALUES (?, ?, 1, 2, ?, ?, 200000)`
        )
        .run(rootId(), `art${nextPath++}.flac`, 'Lit', albumId).lastInsertRowid
    )
    listen({ startedAt: 100, title: 'Lit', artist: 'A', album: 'Rec', trackId: withArt })
    listen({ startedAt: 200, title: 'Dim', artist: 'A', album: 'Rec', trackId: seedTrack('Dim') })

    const rows = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    }).rows
    const byLabel = new Map(rows.map((row) => [row.label, row.artworkHash]))
    // The linked album's hash for the row whose track carries one; the
    // unlinked track's row falls through the LEFT JOIN to null.
    expect(byLabel.get('Lit')).toBe('deadbeef')
    expect(byLabel.get('Dim')).toBeNull()
  })
})

describe('StatsStore.query — order and paging', () => {
  it('orders by time and by listens differently, on the same rows', () => {
    listen({ startedAt: 100, title: 'Short', artist: 'A', msListened: 60_000 })
    listen({ startedAt: 200, title: 'Short', artist: 'A', msListened: 60_000 })
    listen({ startedAt: 300, title: 'Mix', artist: 'B', msListened: 3_600_000 })

    const byListens = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'listens',
      limit: 10,
      offset: 0
    })
    const byTime = store.query({
      range: ALL,
      dimension: 'track',
      sort: 'time',
      limit: 10,
      offset: 0
    })

    expect(byListens.rows.map((row) => row.label)).toEqual(['Short', 'Mix'])
    expect(byTime.rows.map((row) => row.label)).toEqual(['Mix', 'Short'])
    expect(byListens.sort).toBe('listens')
    expect(byTime.sort).toBe('time')
  })

  /**
   * Paging over ties is the case a missing tie-break loses rows in: every group
   * here has one listen and one duration, so nothing but the label orders them.
   */
  it('pages a fully tied ranking without repeating or dropping a row', () => {
    for (let index = 0; index < 10; index += 1) {
      listen({ startedAt: 100 + index, title: `Track ${index}`, artist: 'A' })
    }

    const seen: string[] = []
    for (let offset = 0; offset < 10; offset += 3) {
      const page = store.query({
        range: ALL,
        dimension: 'track',
        sort: 'listens',
        limit: 3,
        offset
      })
      expect(page.total).toBe(10)
      seen.push(...page.rows.map((row) => row.key))
    }

    expect(new Set(seen).size).toBe(10)
  })

  it('echoes the dimension so a late reply can be discarded', () => {
    expect(
      store.query({ range: ALL, dimension: 'genre', sort: 'time', limit: 1, offset: 0 }).dimension
    ).toBe('genre')
  })
})

describe('StatsStore.summary', () => {
  /**
   * The property that lets the headline and the list below it sit on one
   * screen: the summary's counts are the rankings' totals, computed the same
   * way over the same rows.
   */
  it('counts the same distinct groups the rankings page through', () => {
    listen({ startedAt: 100, title: 'A', artist: 'One', album: 'LP', albumArtist: 'One' })
    listen({ startedAt: 200, title: 'B', artist: 'One', album: 'LP', albumArtist: 'One' })
    listen({ startedAt: 300, title: 'C', artist: 'Two', album: null })
    listen({ startedAt: 400, title: 'D', artist: null, album: null, trackId: null })

    const summary = store.summary({ range: ALL, scope: null })
    const total = (dimension: 'track' | 'album' | 'artist'): number =>
      store.query({ range: ALL, dimension, sort: 'listens', limit: 1, offset: 0 }).total

    expect(summary.tracks).toBe(total('track'))
    expect(summary.artists).toBe(total('artist'))
    expect(summary.albums).toBe(total('album'))
    expect(summary).toMatchObject({ listens: 4, tracks: 4, artists: 2, albums: 1 })
  })

  it('sums time and reports the first and last listen in range', () => {
    listen({ startedAt: 100, title: 'A', msListened: 1000 })
    listen({ startedAt: 900, title: 'B', msListened: 2000 })

    expect(store.summary({ range: ALL, scope: null })).toMatchObject({
      msListened: 3000,
      firstListenAt: 100,
      lastListenAt: 900
    })
  })
})

describe('StatsStore.overTime', () => {
  const HOUR = 3_600_000
  const DAY = 86_400_000

  it('buckets from range.from, and keeps the empty buckets', () => {
    const from = 1_000_000_000_000
    listen({ startedAt: from, title: 'A', msListened: 1000 })
    listen({ startedAt: from + HOUR - 1, title: 'B', msListened: 2000 })
    listen({ startedAt: from + 2 * HOUR + 5, title: 'C', msListened: 4000 })

    const series = store.overTime({ range: { from, to: from + 3 * HOUR - 1 }, bucket: 'hour' })

    expect(series.points).toEqual([
      { startedAt: from, listens: 2, msListened: 3000 },
      { startedAt: from + HOUR, listens: 0, msListened: 0 },
      { startedAt: from + 2 * HOUR, listens: 1, msListened: 4000 }
    ])
  })

  /**
   * The alignment argument made concrete: `from` is what the buckets anchor to,
   * so a renderer that sends local midnight gets local days out — with no
   * timezone anywhere in main.
   */
  it('anchors day buckets at from rather than at UTC midnight', () => {
    const localMidnight = 1_000_000_000_000 - 5 * HOUR
    listen({ startedAt: localMidnight + 1, title: 'A' })
    listen({ startedAt: localMidnight + DAY - 1, title: 'B' })
    listen({ startedAt: localMidnight + DAY, title: 'C' })

    const series = store.overTime({
      range: { from: localMidnight, to: localMidnight + 2 * DAY - 1 },
      bucket: 'day'
    })

    expect(series.points.map((point) => point.listens)).toEqual([2, 1])
    expect(series.points[0]?.startedAt).toBe(localMidnight)
  })

  it('reaches the closed upper end, so a listen exactly on to is drawn', () => {
    const from = 0
    const to = 3 * HOUR
    listen({ startedAt: to, title: 'Last', msListened: 500 })

    const series = store.overTime({ range: { from, to }, bucket: 'hour' })

    expect(series.points).toHaveLength(4)
    expect(series.points.at(-1)).toEqual({ startedAt: to, listens: 1, msListened: 500 })
  })

  it('echoes the range and the bucket', () => {
    const range: StatsRange = { from: 0, to: DAY }
    expect(store.overTime({ range, bucket: 'day' })).toMatchObject({ range, bucket: 'day' })
  })
})

/**
 * The Tunedeck's half of the summary (W10-11).
 *
 * A scope is the group the seed track falls into for one dimension, so almost
 * every assertion here is an equality against `query` rather than a literal:
 * that the deck's "42 plays" is the number the top-tracks list puts on that
 * row is the whole reason the scope exists, and a test that hard-coded 42 on
 * both sides would pass through any drift between them.
 *
 * The seeds go into `tracks`/`artists`/`albums` for real, because resolving the
 * snapshot is the part of this that can be wrong — everything above it is the
 * `WHERE` the rest of the file already covers.
 */
describe('StatsStore.summary — scoped to a track', () => {
  /** A library track whose tags are what a listen of it would snapshot. */
  function libraryTrack(tags: {
    title?: string | null
    artist?: string | null
    album?: string | null
    albumArtist?: string | null
  }): number {
    const artistId = (name: string | null | undefined): number | null => {
      if (name === null || name === undefined) return null
      const existing = db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as
        { id: number } | undefined
      if (existing) return existing.id
      return Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
    }

    let albumId: number | null = null
    if (tags.album !== null && tags.album !== undefined) {
      albumId = Number(
        db
          .prepare('INSERT INTO albums (title, album_artist_id) VALUES (?, ?)')
          .run(tags.album, artistId(tags.albumArtist)).lastInsertRowid
      )
    }

    return Number(
      db
        .prepare(
          `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, duration_ms)
           VALUES (?, ?, 1, 2, ?, ?, ?, 200000)`
        )
        .run(rootId(), `s${nextPath++}.flac`, tags.title ?? null, artistId(tags.artist), albumId)
        .lastInsertRowid
    )
  }

  const TAGS = { title: 'Alpha', artist: 'One', album: 'LP', albumArtist: 'One' }

  it('answers the group the seed falls into, for each of the three', () => {
    // Two of the seed track, one more from its album, one more from its artist
    // on another record. Every scope therefore has a different answer, which is
    // what makes a wrong `WHERE` visible rather than coincidentally right.
    listen({ startedAt: 100, ...TAGS, msListened: 1000 })
    listen({ startedAt: 200, ...TAGS, msListened: 2000 })
    listen({ startedAt: 300, title: 'Beta', artist: 'One', album: 'LP', albumArtist: 'One' })
    listen({ startedAt: 400, title: 'Gamma', artist: 'One', album: 'EP', albumArtist: 'One' })
    listen({ startedAt: 500, title: 'Delta', artist: 'Two', album: 'Other', albumArtist: 'Two' })

    const seed = libraryTrack(TAGS)
    const scoped = (by: 'track' | 'album' | 'artist'): ReturnType<typeof store.summary> =>
      store.summary({ range: ALL, scope: { trackId: seed, by } })

    expect(scoped('track')).toMatchObject({
      resolved: true,
      listens: 2,
      msListened: 3000,
      firstListenAt: 100,
      lastListenAt: 200
    })
    expect(scoped('album')).toMatchObject({ resolved: true, listens: 3, tracks: 2 })
    expect(scoped('artist')).toMatchObject({ resolved: true, listens: 4, tracks: 3, albums: 2 })
  })

  /**
   * The equality the scope exists for. A scoped `listens` is the ranked row's
   * `listens` for the same group, so the deck and the dashboard cannot put two
   * different numbers on one artist in one window.
   */
  it('agrees with the ranking row for the same group', () => {
    listen({ startedAt: 100, ...TAGS, msListened: 1000 })
    listen({ startedAt: 200, ...TAGS, msListened: 2000 })
    listen({ startedAt: 300, title: 'Beta', artist: 'One', album: 'LP', albumArtist: 'One' })

    const seed = libraryTrack(TAGS)

    for (const by of ['track', 'album', 'artist'] as const) {
      const summary = store.summary({ range: ALL, scope: { trackId: seed, by } })
      const rows = store.query({
        range: ALL,
        dimension: by,
        sort: 'listens',
        limit: 200,
        offset: 0
      }).rows
      const row = rows.find((candidate) => candidate.listens === summary.listens)
      expect(row?.msListened).toBe(summary.msListened)
    }
  })

  /**
   * The scope matches on `IS`, which is what `GROUP BY` does. With `=` this
   * returns zero for every track missing an artist or an album — and the deck
   * above would draw that as "never played" rather than as a bug.
   */
  it('scopes a track that names no artist and no album to the same group', () => {
    listen({ startedAt: 100, title: 'Nameless', artist: null, album: null })
    listen({ startedAt: 200, title: 'Nameless', artist: null, album: null })
    listen({ startedAt: 300, title: 'Nameless', artist: 'Someone', album: null })

    const seed = libraryTrack({ title: 'Nameless', artist: null, album: null })
    expect(store.summary({ range: ALL, scope: { trackId: seed, by: 'track' } })).toMatchObject({
      resolved: true,
      listens: 2
    })
  })

  /**
   * `resolved: false` and zeros are two different answers, and the pane draws
   * two different sentences from them. A track with no album has nothing to ask
   * about; a track nobody has played yet has an answer, and it is zero.
   */
  it('separates "nothing to ask about" from "not played yet"', () => {
    const bare = libraryTrack({ title: 'Solo', artist: null, album: null })

    expect(store.summary({ range: ALL, scope: { trackId: bare, by: 'album' } })).toMatchObject({
      resolved: false,
      listens: 0
    })
    expect(store.summary({ range: ALL, scope: { trackId: bare, by: 'artist' } })).toMatchObject({
      resolved: false,
      listens: 0
    })
    // Resolves, and answers zero. The card's own wording: a zero is a real
    // answer, and a freshly scanned track must not make a panel disappear.
    expect(store.summary({ range: ALL, scope: { trackId: bare, by: 'track' } })).toMatchObject({
      resolved: true,
      listens: 0,
      firstListenAt: null,
      lastListenAt: null
    })
  })

  it('reports nothing to ask about for a seed that has left the library', () => {
    listen({ startedAt: 100, ...TAGS })

    for (const by of ['track', 'album', 'artist'] as const) {
      expect(store.summary({ range: ALL, scope: { trackId: 9_999, by } })).toMatchObject({
        resolved: false,
        listens: 0
      })
    }
  })

  /**
   * The seed's snapshot is resolved the way the listen commit resolves it, so
   * an override moves the scope onto the history written under the corrected
   * name and off the history written under the old one. That is D17 seen from
   * the deck: the numbers follow the spelling, in both directions.
   */
  it('resolves the seed through its overrides, as the listen commit does', () => {
    listen({ startedAt: 100, title: 'Typo', artist: 'One', album: 'LP', albumArtist: 'One' })
    listen({ startedAt: 200, title: 'Alpha', artist: 'One', album: 'LP', albumArtist: 'One' })

    const seed = libraryTrack({ ...TAGS, title: 'Typo' })
    expect(store.summary({ range: ALL, scope: { trackId: seed, by: 'track' } })).toMatchObject({
      listens: 1,
      firstListenAt: 100
    })

    db.prepare('INSERT INTO track_overrides (track_id, title, updated_at) VALUES (?, ?, 0)').run(
      seed,
      'Alpha'
    )

    expect(store.summary({ range: ALL, scope: { trackId: seed, by: 'track' } })).toMatchObject({
      listens: 1,
      firstListenAt: 200
    })
  })

  it('honours the range, and echoes both the range and the scope', () => {
    listen({ startedAt: 100, ...TAGS })
    listen({ startedAt: 900, ...TAGS })

    const seed = libraryTrack(TAGS)
    const scope = { trackId: seed, by: 'track' } as const
    const range: StatsRange = { from: 0, to: 500 }

    expect(store.summary({ range, scope })).toMatchObject({ range, scope, listens: 1 })
  })
})
