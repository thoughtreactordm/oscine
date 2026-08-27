import { afterEach, describe, expect, it } from 'vitest'
import { buildTasteSeed } from '../../../../src/main/library/discover/seed'
import {
  DAY_MS,
  RECENT_FALLBACK_MS,
  RECENT_MS
} from '../../../../src/main/library/discover/constants'
import {
  NOW,
  addArtist,
  addCompleteAlbum,
  addRoot,
  listenEveryTrack,
  openTempDb,
  rebuild,
  tagTracks
} from './fixture'

describe('buildTasteSeed', () => {
  let close: () => void

  afterEach(() => {
    close?.()
  })

  it('is empty when there are no playable listens', () => {
    const opened = openTempDb()
    close = opened.close
    const rootId = addRoot(opened.db)
    const artist = addArtist(opened.db, 'Nobody')
    addCompleteAlbum(opened.db, {
      rootId,
      artistId: artist,
      title: 'Silence',
      year: 2020,
      genre: 'None',
      tracks: 4
    })
    expect(buildTasteSeed(opened.db, NOW).empty).toBe(true)
  })

  it('stays on the 30-day window once three artists are in it', () => {
    const opened = openTempDb()
    close = opened.close
    const { db } = opened
    const rootId = addRoot(db)
    for (const name of ['A', 'B', 'C']) {
      const artist = addArtist(db, name)
      const album = addCompleteAlbum(db, {
        rootId,
        artistId: artist,
        title: name,
        year: 2020,
        genre: 'X',
        tracks: 4
      })
      listenEveryTrack(db, album.trackIds, NOW - 10 * DAY_MS)
    }
    const old = addArtist(db, 'Old')
    const oldAlbum = addCompleteAlbum(db, {
      rootId,
      artistId: old,
      title: 'Old',
      year: 1990,
      genre: 'Y',
      tracks: 4
    })
    listenEveryTrack(db, oldAlbum.trackIds, NOW - 200 * DAY_MS)
    rebuild(db)

    const seed = buildTasteSeed(db, NOW)
    expect(seed.empty).toBe(false)
    expect(seed.windowMs).toBe(RECENT_MS)
    expect([...seed.artistIds].sort()).toEqual(
      [artistId(db, 'A'), artistId(db, 'B'), artistId(db, 'C')].sort()
    )
    expect(seed.artistIds).not.toContain(artistId(db, 'Old'))
  })

  it('widens to 90 days when the 30-day seed is too thin', () => {
    const opened = openTempDb()
    close = opened.close
    const { db } = opened
    const rootId = addRoot(db)
    const recent = addArtist(db, 'Recent')
    const mid = addArtist(db, 'Mid')
    const mid2 = addArtist(db, 'Mid2')
    listenEveryTrack(
      db,
      addCompleteAlbum(db, {
        rootId,
        artistId: recent,
        title: 'Recent',
        year: 2020,
        genre: 'X',
        tracks: 4
      }).trackIds,
      NOW - 10 * DAY_MS
    )
    listenEveryTrack(
      db,
      addCompleteAlbum(db, {
        rootId,
        artistId: mid,
        title: 'Mid',
        year: 2020,
        genre: 'X',
        tracks: 4
      }).trackIds,
      NOW - 60 * DAY_MS
    )
    listenEveryTrack(
      db,
      addCompleteAlbum(db, {
        rootId,
        artistId: mid2,
        title: 'Mid2',
        year: 2020,
        genre: 'X',
        tracks: 4
      }).trackIds,
      NOW - 80 * DAY_MS
    )
    rebuild(db)

    const seed = buildTasteSeed(db, NOW)
    expect(seed.windowMs).toBe(RECENT_FALLBACK_MS)
    expect(seed.artistIds).toHaveLength(3)
  })

  it('widens to all-time rather than recommend from one artist', () => {
    const opened = openTempDb()
    close = opened.close
    const { db } = opened
    const rootId = addRoot(db)
    const names = ['One', 'Two', 'Three']
    names.forEach((name, index) => {
      const artist = addArtist(db, name)
      listenEveryTrack(
        db,
        addCompleteAlbum(db, {
          rootId,
          artistId: artist,
          title: name,
          year: 2000,
          genre: 'X',
          tracks: 4
        }).trackIds,
        NOW - (100 + index) * DAY_MS
      )
    })
    rebuild(db)

    const seed = buildTasteSeed(db, NOW)
    expect(seed.windowMs).toBeNull()
    expect(seed.artistIds).toHaveLength(3)
  })

  it('takes taste keys from user tags as well as file genres (W15-6)', () => {
    const opened = openTempDb()
    close = opened.close
    const { db } = opened
    const rootId = addRoot(db)
    for (const name of ['A', 'B', 'C']) {
      const artist = addArtist(db, name)
      const album = addCompleteAlbum(db, {
        rootId,
        artistId: artist,
        title: name,
        year: 2020,
        genre: 'Krautrock',
        tracks: 4
      })
      // Hand-tag what you play; the tag key must steer the seed like a genre.
      tagTracks(db, 'Workout', album.trackIds)
      listenEveryTrack(db, album.trackIds, NOW - 10 * DAY_MS)
    }
    rebuild(db)

    const seed = buildTasteSeed(db, NOW)
    expect(seed.genreKeys).toContain('krautrock')
    expect(seed.genreKeys).toContain('workout')
  })

  it('weights a key carried by both vocabularies once per listen (W15-6)', () => {
    const opened = openTempDb()
    close = opened.close
    const { db } = opened
    const rootId = addRoot(db)
    const artist = addArtist(db, 'Solo')
    const album = addCompleteAlbum(db, {
      rootId,
      artistId: artist,
      title: 'Solo',
      year: 2020,
      genre: 'Jazz',
      tracks: 4
    })
    // The file genre and the user tag fold to the same key: a listen must count
    // its ms toward `jazz` once, not twice.
    tagTracks(db, 'Jazz', album.trackIds)
    listenEveryTrack(db, album.trackIds, NOW - 10 * DAY_MS, 90_000)
    rebuild(db)

    const seed = buildTasteSeed(db, NOW)
    const jazzKeys = [...seed.genreKeys].filter((key) => key === 'jazz')
    expect(jazzKeys).toEqual(['jazz'])
    expect(seed.genreMs.get('jazz')).toBe(4 * 90_000)
  })
})

function artistId(db: import('better-sqlite3').Database, name: string): number {
  return (db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as { id: number }).id
}
