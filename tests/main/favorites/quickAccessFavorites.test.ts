import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { SqliteFavoriteService } from '../../../src/main/favorites/service'

/**
 * The playlist and artist stars — **D24** (W13-3).
 *
 * Driven through the real migration list against a real SQLite file, like the
 * track heart's own tests and for the same two reasons: the claims are about
 * what is durably in the two new tables, and the load-bearing one — that
 * deleting the underlying playlist or artist takes its star with it — is a
 * `CASCADE` a fake would not have.
 *
 * The star has none of the heart's network arrangement: it is local, so nothing
 * here asserts an outbox row, and the last block asserts the heart's own table
 * is never touched by a star.
 */

let dir: string
let file: string
let db: Database.Database

let nextName = 0
let nextPos = 0

function service(): SqliteFavoriteService {
  return new SqliteFavoriteService({ db })
}

function seedPlaylist(name = `Playlist ${nextName++}`): number {
  return Number(
    db
      .prepare('INSERT INTO playlists (name, position, created_at, updated_at) VALUES (?, ?, 0, 0)')
      .run(name, nextPos++).lastInsertRowid
  )
}

function seedArtist(name = `Artist ${nextName++}`): number {
  return Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
}

function seedAlbum(
  artistId: number,
  title: string,
  year: number | null,
  artworkHash: string | null
): number {
  return Number(
    db
      .prepare(
        'INSERT INTO albums (title, album_artist_id, year, artwork_hash) VALUES (?, ?, ?, ?)'
      )
      .run(title, artistId, year, artworkHash).lastInsertRowid
  )
}

/** A track under a single root, optionally attached to a playlist by one entry. */
function seedTrackInPlaylist(playlistId: number): void {
  const rootId =
    (db.prepare('SELECT id FROM roots LIMIT 1').get() as { id: number } | undefined)?.id ??
    Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Music', '/music', 0).lastInsertRowid
    )
  const trackId = Number(
    db
      .prepare(
        `INSERT INTO tracks (root_id, rel_path, mtime, size, title, duration_ms)
         VALUES (?, ?, 1, 2, 'T', 200000)`
      )
      .run(rootId, `p${nextName++}.flac`).lastInsertRowid
  )
  db.prepare(
    'INSERT INTO playlist_entries (playlist_id, track_id, position) VALUES (?, ?, 1.0)'
  ).run(playlistId, trackId)
}

function starPlaylistAt(playlistId: number, at: number): void {
  db.prepare('INSERT INTO playlist_favorites (playlist_id, favorited_at) VALUES (?, ?)').run(
    playlistId,
    at
  )
}

function starArtistAt(artistId: number, at: number): void {
  db.prepare('INSERT INTO artist_favorites (artist_id, favorited_at) VALUES (?, ?)').run(
    artistId,
    at
  )
}

function playlistFavoriteRows(): { playlist_id: number; favorited_at: number }[] {
  return db.prepare('SELECT * FROM playlist_favorites ORDER BY playlist_id').all() as {
    playlist_id: number
    favorited_at: number
  }[]
}

function artistFavoriteRows(): { artist_id: number; favorited_at: number }[] {
  return db.prepare('SELECT * FROM artist_favorites ORDER BY artist_id').all() as {
    artist_id: number
    favorited_at: number
  }[]
}

function trackFavoriteRows(): unknown[] {
  return db.prepare('SELECT * FROM track_favorites').all()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-quick-favorites-'))
  file = join(dir, 'library.db')
  db = openDatabase(file).db
  nextName = 0
  nextPos = 0
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('favorites.togglePlaylist', () => {
  it('stars a playlist and reports the state that resulted', async () => {
    const playlistId = seedPlaylist()

    const state = await service().togglePlaylist(playlistId)

    expect(state).toEqual({ favoritedIds: [playlistId] })
    expect(playlistFavoriteRows()).toEqual([
      { playlist_id: playlistId, favorited_at: expect.any(Number) }
    ])
  })

  it('un-stars on the second call and deletes the row rather than marking it', async () => {
    const playlistId = seedPlaylist()
    const favorites = service()

    await favorites.togglePlaylist(playlistId)
    const state = await favorites.togglePlaylist(playlistId)

    expect(state).toEqual({ favoritedIds: [] })
    expect(playlistFavoriteRows()).toEqual([])
  })

  it('leaves at most one row however many times it is toggled', async () => {
    const playlistId = seedPlaylist()
    const favorites = service()

    for (let i = 0; i < 5; i += 1) {
      const state = await favorites.togglePlaylist(playlistId)
      const starred = i % 2 === 0
      expect(state.favoritedIds).toEqual(starred ? [playlistId] : [])
      expect(playlistFavoriteRows()).toHaveLength(starred ? 1 : 0)
    }
  })

  it('answers "not favorited" for a playlist that does not exist', async () => {
    const state = await service().togglePlaylist(9_999)

    expect(state).toEqual({ favoritedIds: [] })
    expect(playlistFavoriteRows()).toEqual([])
  })
})

describe('favorites.playlistState', () => {
  it('returns exactly the starred subset of the ids it was given', async () => {
    const starred = seedPlaylist()
    const plain = seedPlaylist()
    await service().togglePlaylist(starred)

    const result = await service().playlistState([starred, plain, 9_999])

    expect(result.favoritedIds).toEqual([starred])
  })

  it('collapses a duplicated id rather than answering about it twice', async () => {
    const starred = seedPlaylist()
    await service().togglePlaylist(starred)

    expect((await service().playlistState([starred, starred, starred])).favoritedIds).toEqual([
      starred
    ])
  })

  it('takes an empty batch without asking the database anything', async () => {
    expect((await service().playlistState([])).favoritedIds).toEqual([])
  })
})

describe('favorites.listPlaylists', () => {
  it('lists newest-starred first and returns the full playlist shape', async () => {
    const first = seedPlaylist('First')
    const second = seedPlaylist('Second')
    const third = seedPlaylist('Third')
    seedTrackInPlaylist(second)
    seedTrackInPlaylist(second)
    starPlaylistAt(first, 1_000)
    starPlaylistAt(second, 3_000)
    starPlaylistAt(third, 2_000)

    const result = await service().listPlaylists(10)

    expect(result.playlists.map((p) => p.name)).toEqual(['Second', 'Third', 'First'])
    // The projection is the shared one, so trackCount and the ISO timestamps ride
    // along rather than being re-derived here.
    const secondCard = result.playlists.find((p) => p.name === 'Second')
    expect(secondCard).toEqual({
      id: second,
      name: 'Second',
      trackCount: 2,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z'
    })
  })

  it('respects the limit, keeping the newest-starred', async () => {
    const older = seedPlaylist('Older')
    const newer = seedPlaylist('Newer')
    starPlaylistAt(older, 1_000)
    starPlaylistAt(newer, 2_000)

    const result = await service().listPlaylists(1)

    expect(result.playlists.map((p) => p.name)).toEqual(['Newer'])
  })

  it('breaks ties on the playlist id, newest first', async () => {
    const lower = seedPlaylist('Lower')
    const higher = seedPlaylist('Higher')
    starPlaylistAt(lower, 5_000)
    starPlaylistAt(higher, 5_000)

    const result = await service().listPlaylists(10)

    expect(result.playlists.map((p) => p.id)).toEqual([higher, lower])
  })

  it('is empty when nothing is starred', async () => {
    seedPlaylist()
    expect(await service().listPlaylists(10)).toEqual({ playlists: [] })
  })
})

describe('favorites.toggleArtist', () => {
  it('stars an artist and reports the state that resulted', async () => {
    const artistId = seedArtist()

    const state = await service().toggleArtist(artistId)

    expect(state).toEqual({ favoritedIds: [artistId] })
    expect(artistFavoriteRows()).toEqual([
      { artist_id: artistId, favorited_at: expect.any(Number) }
    ])
  })

  it('un-stars on the second call, leaving at most one row', async () => {
    const artistId = seedArtist()
    const favorites = service()

    for (let i = 0; i < 5; i += 1) {
      const state = await favorites.toggleArtist(artistId)
      const starred = i % 2 === 0
      expect(state.favoritedIds).toEqual(starred ? [artistId] : [])
      expect(artistFavoriteRows()).toHaveLength(starred ? 1 : 0)
    }
  })

  it('answers "not favorited" for an artist that does not exist', async () => {
    const state = await service().toggleArtist(9_999)

    expect(state).toEqual({ favoritedIds: [] })
    expect(artistFavoriteRows()).toEqual([])
  })
})

describe('favorites.artistState', () => {
  it('returns exactly the starred subset of the ids it was given', async () => {
    const starred = seedArtist()
    const plain = seedArtist()
    await service().toggleArtist(starred)

    const result = await service().artistState([starred, plain, 9_999])

    expect(result.favoritedIds).toEqual([starred])
  })

  it('takes an empty batch without asking the database anything', async () => {
    expect((await service().artistState([])).favoritedIds).toEqual([])
  })
})

describe('favorites.listArtists', () => {
  it('lists newest-starred first, id and name', async () => {
    const first = seedArtist('Slowdive')
    const second = seedArtist('Ride')
    const third = seedArtist('Lush')
    starArtistAt(first, 1_000)
    starArtistAt(second, 3_000)
    starArtistAt(third, 2_000)

    const result = await service().listArtists(10)

    expect(result.artists.map((a) => a.name)).toEqual(['Ride', 'Lush', 'Slowdive'])
  })

  it('borrows the artwork hash from the artist’s newest album that has one', async () => {
    const artist = seedArtist('Cocteau Twins')
    // An older album with art, a newer one without: the newest album *with* a
    // hash wins, not simply the newest album.
    seedAlbum(artist, 'Treasure', 1984, 'hash-treasure')
    seedAlbum(artist, 'Heaven or Las Vegas', 1990, 'hash-heaven')
    seedAlbum(artist, 'Four-Calendar Café', 1993, null)
    starArtistAt(artist, 1_000)

    const result = await service().listArtists(10)

    expect(result.artists).toEqual([
      { id: artist, name: 'Cocteau Twins', artworkHash: 'hash-heaven' }
    ])
  })

  it('reports a null hash for an artist with no album art', async () => {
    const withoutArt = seedArtist('No Art')
    seedAlbum(withoutArt, 'Untitled', 2000, null)
    const withoutAlbum = seedArtist('No Albums')
    starArtistAt(withoutArt, 2_000)
    starArtistAt(withoutAlbum, 1_000)

    const result = await service().listArtists(10)

    expect(result.artists).toEqual([
      { id: withoutArt, name: 'No Art', artworkHash: null },
      { id: withoutAlbum, name: 'No Albums', artworkHash: null }
    ])
  })

  it('respects the limit, keeping the newest-starred', async () => {
    const older = seedArtist('Older')
    const newer = seedArtist('Newer')
    starArtistAt(older, 1_000)
    starArtistAt(newer, 2_000)

    const result = await service().listArtists(1)

    expect(result.artists.map((a) => a.name)).toEqual(['Newer'])
  })

  it('is empty when nothing is starred', async () => {
    seedArtist()
    expect(await service().listArtists(10)).toEqual({ artists: [] })
  })
})

describe('the CASCADE', () => {
  it('drops a playlist star when the playlist is deleted', async () => {
    const playlistId = seedPlaylist()
    await service().togglePlaylist(playlistId)

    db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId)

    expect(playlistFavoriteRows()).toEqual([])
    expect((await service().listPlaylists(10)).playlists).toEqual([])
  })

  it('drops an artist star when the artist is deleted', async () => {
    const artistId = seedArtist()
    await service().toggleArtist(artistId)

    db.prepare('DELETE FROM artists WHERE id = ?').run(artistId)

    expect(artistFavoriteRows()).toEqual([])
    expect((await service().listArtists(10)).artists).toEqual([])
  })
})

describe('the track heart is untouched', () => {
  /** Done-when: the star owns its own tables and never reaches `track_favorites`. */
  it('writes nothing to track_favorites when a playlist or artist is starred', async () => {
    const favorites = service()
    await favorites.togglePlaylist(seedPlaylist())
    await favorites.toggleArtist(seedArtist())

    expect(trackFavoriteRows()).toEqual([])
  })
})
