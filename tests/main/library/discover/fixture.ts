import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { normalizeLabel, splitGenres } from '@shared/genre'
import { openDatabase } from '../../../../src/main/db'
import { rebuildTrackCounters } from '../../../../src/main/stats/counters'
import { DAY_MS } from '../../../../src/main/library/discover/constants'

/** 2024-06-15T12:00:00.000Z — noon so ±12h stays on the same UTC day. */
export const NOW = Date.UTC(2024, 5, 15, 12, 0, 0)

export function openTempDb(): { db: Database.Database; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'oscine-discover-'))
  const opened = openDatabase(join(dir, 'library.db'))
  return {
    db: opened.db,
    close: () => {
      opened.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export function addRoot(db: Database.Database, path = '/library'): number {
  return Number(
    db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)').run('Music', path, 1)
      .lastInsertRowid
  )
}

export function addArtist(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
}

export function addAlbum(
  db: Database.Database,
  title: string,
  artistId: number,
  year: number | null = 2000
): number {
  return Number(
    db
      .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)')
      .run(title, artistId, year).lastInsertRowid
  )
}

let pathSeq = 0

export function addTrack(
  db: Database.Database,
  options: {
    rootId: number
    albumId: number
    artistId: number
    title: string
    trackNo: number
    genre: string | null
  }
): number {
  const relPath = `${options.artistId}/${options.albumId}/${pathSeq++}.flac`
  const id = Number(
    db
      .prepare(
        `INSERT INTO tracks (
           root_id, rel_path, mtime, size, duration_ms, title, artist_id,
           album_id, track_no, disc_no, genre
         ) VALUES (?, ?, 1, 1000, 200000, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        options.rootId,
        relPath,
        options.title,
        options.artistId,
        options.albumId,
        options.trackNo,
        options.genre
      ).lastInsertRowid
  )
  const insertGenre = db.prepare(
    'INSERT INTO track_genres (track_id, genre_key, genre) VALUES (?, ?, ?)'
  )
  for (const part of splitGenres(options.genre)) insertGenre.run(id, part.key, part.genre)
  return id
}

/** `count` tracks, numbered from 1, all the same genre and performer. */
export function addCompleteAlbum(
  db: Database.Database,
  options: {
    rootId: number
    artistId: number
    title: string
    year: number | null
    genre: string
    tracks: number
    /** Track performer; defaults to the album artist. */
    performerId?: number
  }
): { albumId: number; trackIds: number[] } {
  const albumId = addAlbum(db, options.title, options.artistId, options.year)
  const performerId = options.performerId ?? options.artistId
  const trackIds: number[] = []
  for (let trackNo = 1; trackNo <= options.tracks; trackNo++) {
    trackIds.push(
      addTrack(db, {
        rootId: options.rootId,
        albumId,
        artistId: performerId,
        title: `${options.title} ${String(trackNo).padStart(2, '0')}`,
        trackNo,
        genre: options.genre
      })
    )
  }
  return { albumId, trackIds }
}

/** Album artist and per-track performers may differ — compilations, features. */
export function addMixedAlbum(
  db: Database.Database,
  options: {
    rootId: number
    albumArtistId: number
    title: string
    year: number | null
    genre: string
    tracks: readonly { artistId: number; title?: string }[]
  }
): { albumId: number; trackIds: number[] } {
  const albumId = addAlbum(db, options.title, options.albumArtistId, options.year)
  const trackIds: number[] = []
  options.tracks.forEach((track, index) => {
    const trackNo = index + 1
    trackIds.push(
      addTrack(db, {
        rootId: options.rootId,
        albumId,
        artistId: track.artistId,
        title: track.title ?? `${options.title} ${String(trackNo).padStart(2, '0')}`,
        trackNo,
        genre: options.genre
      })
    )
  })
  return { albumId, trackIds }
}

/**
 * Apply a user tag to tracks — the `track_tags` layer the genre recipes union
 * in (W15-6). The tag is upserted by its casefold key, the same fold
 * `track_genres.genre_key` uses, so `tagTracks(db, 'IDM', …)` shares a bucket
 * with a file genre `idm`.
 */
export function tagTracks(
  db: Database.Database,
  label: string,
  trackIds: readonly number[],
  source: 'user' | 'suggested' = 'user'
): void {
  const norm = normalizeLabel(label)
  if (norm === null) throw new Error(`empty tag label: ${label}`)
  db.prepare(
    `INSERT INTO tags (key, label, created_at) VALUES (?, ?, 1)
     ON CONFLICT(key) DO NOTHING`
  ).run(norm.key, norm.label)
  const tagId = (db.prepare('SELECT id FROM tags WHERE key = ?').get(norm.key) as { id: number }).id
  const link = db.prepare(
    `INSERT INTO track_tags (track_id, tag_id, source, created_at) VALUES (?, ?, ?, 1)
     ON CONFLICT(track_id, tag_id) DO NOTHING`
  )
  for (const trackId of trackIds) link.run(trackId, tagId, source)
}

export function addFavorite(db: Database.Database, trackId: number, favoritedAt: number): void {
  db.prepare('INSERT INTO track_favorites (track_id, favorited_at) VALUES (?, ?)').run(
    trackId,
    favoritedAt
  )
}

export function addListen(
  db: Database.Database,
  trackId: number,
  startedAt: number,
  msListened = 90_000
): void {
  const track = db
    .prepare(
      `SELECT t.title AS title,
              ar.name AS artist,
              al.title AS album
       FROM tracks t
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE t.id = ?`
    )
    .get(trackId) as { title: string | null; artist: string | null; album: string | null }
  db.prepare(
    `INSERT INTO listens
       (track_id, started_at, ms_listened, duration_ms,
        title, artist_name, album_title, album_artist_name)
     VALUES (?, ?, ?, 200000, ?, ?, ?, ?)`
  ).run(
    trackId,
    startedAt,
    msListened,
    track.title ?? `track-${trackId}`,
    track.artist,
    track.album,
    track.artist
  )
}

export function listenEveryTrack(
  db: Database.Database,
  trackIds: readonly number[],
  startedAt: number,
  msListened = 90_000
): void {
  trackIds.forEach((trackId, index) => addListen(db, trackId, startedAt + index, msListened))
}

export function rebuild(db: Database.Database): void {
  rebuildTrackCounters(db)
}

/**
 * The generated library the spec names for recipes 1–4.
 *
 * Alpha: 6 albums, old heavy listening on 1–2, 3–6 unplayed → *artists*.
 * Fox / Grove / Hale: recent listens plus unplayed remainder → taste seed and
 * *for-you*. Echo: three long-ago finished albums → *revisit*. Moss: unplayed
 * albums outside the seed → *unplayed* after exclusion.
 */
export function seedCatalog(db: Database.Database): {
  rootId: number
  alpha: number
  foxUnplayed: string[]
} {
  const rootId = addRoot(db)
  const alpha = addArtist(db, 'Alpha')
  const fox = addArtist(db, 'Fox')
  const grove = addArtist(db, 'Grove')
  const hale = addArtist(db, 'Hale')
  const echo = addArtist(db, 'Echo')
  const moss = addArtist(db, 'Moss')

  for (let index = 1; index <= 6; index++) {
    const album = addCompleteAlbum(db, {
      rootId,
      artistId: alpha,
      title: `Alpha ${index}`,
      year: 1989 + index,
      genre: 'Kraut',
      tracks: 4
    })
    if (index <= 2) {
      // Enough plays that these are a habit, not *revisit*'s "played once".
      for (let play = 0; play < 5; play++) {
        listenEveryTrack(db, album.trackIds, NOW - 400 * DAY_MS + play * 1_000, 180_000)
      }
    }
  }

  const foxUnplayed: string[] = []
  for (const [artistId, name, genre] of [
    [fox, 'Fox', 'SeedPop'],
    [grove, 'Grove', 'SeedJazz'],
    [hale, 'Hale', 'SeedFolk']
  ] as const) {
    const heavy = addCompleteAlbum(db, {
      rootId,
      artistId,
      title: `${name} Heavy`,
      year: 2020,
      genre,
      tracks: 4
    })
    listenEveryTrack(db, heavy.trackIds, NOW - 2 * DAY_MS, 90_000)
    for (let rest = 1; rest <= 3; rest++) {
      const title = `${name} Rest ${rest}`
      addCompleteAlbum(db, {
        rootId,
        artistId,
        title,
        year: 2010 + rest,
        genre,
        tracks: 4
      })
      if (name === 'Fox') foxUnplayed.push(title)
    }
  }

  for (let index = 1; index <= 3; index++) {
    const album = addCompleteAlbum(db, {
      rootId,
      artistId: echo,
      title: `Echo ${index}`,
      year: 2001,
      genre: 'Ambient',
      tracks: 8
    })
    listenEveryTrack(db, album.trackIds, NOW - 200 * DAY_MS, 60_000)
  }

  for (let index = 1; index <= 4; index++) {
    addCompleteAlbum(db, {
      rootId,
      artistId: moss,
      title: `Moss ${index}`,
      year: 2015,
      genre: 'Dust',
      tracks: 4
    })
  }

  rebuild(db)
  return { rootId, alpha, foxUnplayed }
}

/**
 * Spec fixture rows for recipes 5–9, layered on `seedCatalog`.
 *
 * Beta: a heart and three unplayed albums, not Alpha → *because-favorited*.
 * Hole: mixed play counts, recent enough to not be *revisit* → *almost-finished*.
 * Forgot: hearted cold tracks → *forgotten-favorites*.
 * Gloam vs the seed genres: a large unplayed genre → *neglected-genre*.
 * Various: Fox as performer, not album artist → *guest-appearances*.
 * Other 1–8: unplayed filler so *unplayed* cannot drain Gloam.
 */
export function seedExtras(db: Database.Database, rootId: number): void {
  const fox = artistId(db, 'Fox')
  const beta = addArtist(db, 'Beta')
  const gap = addArtist(db, 'Gap')
  const forgot = addArtist(db, 'Forgot')
  const glen = addArtist(db, 'Glen')
  const various = addArtist(db, 'Various')

  for (let index = 1; index <= 3; index++) {
    const album = addCompleteAlbum(db, {
      rootId,
      artistId: beta,
      title: `Beta ${index}`,
      year: 2018 + index,
      genre: 'BetaRock',
      tracks: 4
    })
    if (index === 1) addFavorite(db, album.trackIds[0]!, NOW - 10 * DAY_MS)
  }

  for (let index = 1; index <= 3; index++) {
    const album = addCompleteAlbum(db, {
      rootId,
      artistId: gap,
      title: `Hole ${index}`,
      year: 2019,
      genre: 'GapRock',
      tracks: 10
    })
    listenEveryTrack(db, album.trackIds.slice(0, 7), NOW - 40 * DAY_MS)
  }

  for (let index = 1; index <= 3; index++) {
    const album = addCompleteAlbum(db, {
      rootId,
      artistId: forgot,
      title: `Forgot ${index}`,
      year: 2016,
      genre: 'Forgot',
      tracks: 2
    })
    addFavorite(db, album.trackIds[0]!, NOW - index * DAY_MS)
    if (index === 3) addListen(db, album.trackIds[0]!, NOW - 200 * DAY_MS)
  }

  for (let index = 1; index <= 10; index++) {
    addCompleteAlbum(db, {
      rootId,
      artistId: glen,
      title: `Glen ${index}`,
      year: 2014,
      genre: 'Gloam',
      tracks: 4
    })
  }

  for (let index = 1; index <= 8; index++) {
    addCompleteAlbum(db, {
      rootId,
      artistId: addArtist(db, `Other ${index}`),
      title: `Other ${index}`,
      year: 2012,
      genre: 'Other',
      tracks: 4
    })
  }

  for (let index = 1; index <= 3; index++) {
    addMixedAlbum(db, {
      rootId,
      albumArtistId: various,
      title: `Various ${index}`,
      year: 2011,
      genre: 'Comp',
      tracks: [
        { artistId: fox },
        { artistId: various },
        { artistId: various },
        { artistId: various }
      ]
    })
  }

  rebuild(db)
}

function artistId(db: Database.Database, name: string): number {
  return (db.prepare('SELECT id FROM artists WHERE name = ?').get(name) as { id: number }).id
}
