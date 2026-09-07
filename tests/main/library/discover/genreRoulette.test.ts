import { afterEach, describe, expect, it } from 'vitest'
import type { DiscoverShelf } from '@shared/discover'
import { genreRoulette } from '../../../../src/main/library/discover/recipes/genreRoulette'
import { compose } from '../../../../src/main/library/discover/compose'
import { emptyClaimed } from '../../../../src/main/library/discover/types'
import {
  DAY_MS,
  SHELF_ITEM_CAP,
  SHELF_MIN_ITEMS
} from '../../../../src/main/library/discover/constants'
import {
  NOW,
  addArtist,
  addCompleteAlbum,
  addRoot,
  openTempDb,
  rebuild,
  tagTracks
} from './fixture'

const CRATE = "Tonight's crate: "

/** The genre named in the shelf title. */
function pickedGenre(shelf: { title: string }): string {
  return shelf.title.slice(CRATE.length)
}

/** A library of `genres.length` genres, each `perGenre` complete 4-track albums. */
function seedGenres(genres: readonly string[], perGenre: number): ReturnType<typeof openTempDb> {
  const opened = openTempDb()
  const rootId = addRoot(opened.db)
  for (const genre of genres) {
    for (let index = 1; index <= perGenre; index++) {
      addCompleteAlbum(opened.db, {
        rootId,
        artistId: addArtist(opened.db, `${genre} artist ${index}`),
        title: `${genre} ${index}`,
        year: 2000 + index,
        genre,
        tracks: 4
      })
    }
  }
  rebuild(opened.db)
  return opened
}

describe('genreRoulette', () => {
  let close: () => void

  afterEach(() => close?.())

  it('picks one genre by the day and fills an album shelf from it', () => {
    const opened = seedGenres(['Ambient', 'Doom', 'Jazz', 'Kraut', 'Rock'], 4)
    close = opened.close

    const output = genreRoulette(opened.db, NOW, emptyClaimed())
    expect(output).not.toBeNull()
    expect(output!.grain).toBe('album')
    expect(output!.title.startsWith(CRATE)).toBe(true)

    const genre = pickedGenre(output!)
    expect(output!.items.length).toBeGreaterThanOrEqual(SHELF_MIN_ITEMS)
    expect(output!.items.length).toBeLessThanOrEqual(SHELF_ITEM_CAP)
    expect(output!.items.every((item) => item.title.startsWith(genre))).toBe(true)
  })

  it('is byte-identical for the same library and day', () => {
    const opened = seedGenres(['Ambient', 'Doom', 'Jazz', 'Kraut', 'Rock'], 4)
    close = opened.close

    const first = genreRoulette(opened.db, NOW, emptyClaimed())
    const second = genreRoulette(opened.db, NOW, emptyClaimed())
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('rotates the genre across UTC days', () => {
    const opened = seedGenres(['Ambient', 'Doom', 'Jazz', 'Kraut', 'Rock'], 4)
    close = opened.close

    const genres = new Set<string>()
    for (let day = 0; day < 40; day++) {
      const output = genreRoulette(opened.db, NOW + day * DAY_MS, emptyClaimed())
      genres.add(pickedGenre(output!))
    }
    expect(genres.size).toBeGreaterThan(1)
  })

  it('omits when no genre has enough albums to fill a shelf', () => {
    const opened = seedGenres(['Ambient', 'Doom'], 2)
    close = opened.close
    expect(genreRoulette(opened.db, NOW, emptyClaimed())).toBeNull()
  })

  it('does not count singles: albums below the track floor never fill a genre', () => {
    const opened = openTempDb()
    close = opened.close
    const rootId = addRoot(opened.db)
    for (let index = 1; index <= 5; index++) {
      addCompleteAlbum(opened.db, {
        rootId,
        artistId: addArtist(opened.db, `Single ${index}`),
        title: `Single ${index}`,
        year: 2000 + index,
        genre: 'Rock',
        tracks: 2
      })
    }
    rebuild(opened.db)
    expect(genreRoulette(opened.db, NOW, emptyClaimed())).toBeNull()
  })

  it('drops a genre from the pool once claims take it below the floor', () => {
    const opened = seedGenres(['Doom'], 4)
    close = opened.close

    // Uncontested, Doom is the only pool genre and fills.
    const before = genreRoulette(opened.db, NOW, emptyClaimed())
    expect(before).not.toBeNull()

    // Claim two of the four albums: two remain, below SHELF_MIN_ITEMS.
    const claimed = emptyClaimed()
    const albums = opened.db.prepare('SELECT id FROM albums LIMIT 2').all() as { id: number }[]
    for (const { id } of albums) claimed.albumIds.add(id)
    expect(genreRoulette(opened.db, NOW, claimed)).toBeNull()
  })

  it('treats a user-tag-only key as a first-class genre (W15 parity)', () => {
    const opened = openTempDb()
    close = opened.close
    const rootId = addRoot(opened.db)
    for (let index = 1; index <= 4; index++) {
      const album = addCompleteAlbum(opened.db, {
        rootId,
        artistId: addArtist(opened.db, `Gym ${index}`),
        title: `Gym ${index}`,
        year: 2015,
        genre: '',
        tracks: 4
      })
      tagTracks(opened.db, 'Workout', album.trackIds)
    }
    rebuild(opened.db)

    const output = genreRoulette(opened.db, NOW, emptyClaimed())
    expect(output).not.toBeNull()
    expect(output!.title).toBe("Tonight's crate: Workout")
    expect(output!.items.every((item) => item.title.startsWith('Gym'))).toBe(true)
  })
})

describe('genreRoulette through compose', () => {
  let close: () => void

  afterEach(() => close?.())

  it('produces a shelf at cold start and renders it under for-you, above unplayed', () => {
    const opened = openTempDb()
    close = opened.close
    const rootId = addRoot(opened.db)
    // One large genre, distinct artists, no listens: unplayed takes its cap and
    // genre-roulette still finds enough of the remainder to fill.
    for (let index = 1; index <= 16; index++) {
      addCompleteAlbum(opened.db, {
        rootId,
        artistId: addArtist(opened.db, `Doom ${index}`),
        title: `Doom ${index}`,
        year: 2000 + index,
        genre: 'Doom',
        tracks: 4
      })
    }
    rebuild(opened.db)

    const result = compose(opened.db, NOW)
    const ids = result.shelves.map((shelf: DiscoverShelf) => shelf.id)
    expect(ids).toContain('genre-roulette')
    expect(ids).toContain('unplayed')
    // Prominence: genre-roulette renders before unplayed despite claiming last.
    expect(ids.indexOf('genre-roulette')).toBeLessThan(ids.indexOf('unplayed'))

    const roulette = result.shelves.find((shelf: DiscoverShelf) => shelf.id === 'genre-roulette')!
    expect(roulette.items.length).toBeGreaterThanOrEqual(SHELF_MIN_ITEMS)
    expect(roulette.items.every((item) => item.title.startsWith('Doom'))).toBe(true)
  })
})
