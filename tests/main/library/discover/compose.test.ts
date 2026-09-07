import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DiscoverItem, DiscoverShelf } from '@shared/discover'
import { compose, DiscoverEngine, memoKey } from '../../../../src/main/library/discover/compose'
import {
  DAY_MS,
  SHELF_ITEM_CAP,
  SHELF_MIN_ITEMS
} from '../../../../src/main/library/discover/constants'
import {
  NOW,
  addCompleteAlbum,
  addFavorite,
  addRoot,
  addArtist,
  openTempDb,
  seedCatalog,
  seedExtras
} from './fixture'

function titles(shelf: DiscoverShelf | undefined): string[] {
  return (shelf?.items ?? []).map((item) => item.title)
}

function albumIds(shelf: DiscoverShelf | undefined): number[] {
  return (shelf?.items ?? [])
    .filter((item): item is Extract<DiscoverItem, { grain: 'album' }> => item.grain === 'album')
    .map((item) => item.albumId)
}

describe('compose — catalog fixture', () => {
  let close: () => void
  let result: ReturnType<typeof compose>

  beforeAll(() => {
    const opened = openTempDb()
    close = opened.close
    seedCatalog(opened.db)
    result = compose(opened.db, NOW)
  })

  afterAll(() => close())

  function shelf(id: string): DiscoverShelf | undefined {
    return result.shelves.find((entry) => entry.id === id)
  }

  it('stamps the UTC day of the injected clock', () => {
    expect(result.dayKey).toBe('2024-06-15')
  })

  it('fills the four placeholder shelves for the reasons the spec names', () => {
    expect(result.shelves.map((entry) => entry.id)).toEqual([
      'for-you',
      'artists',
      'unplayed',
      'revisit'
    ])
  })

  it('builds for-you from the recent seed, excluding heavy rotation', () => {
    const forYou = shelf('for-you')
    expect(forYou?.title).toBe('Built for you')
    expect(forYou?.hint).toBe('From what you have been playing.')
    expect(forYou?.grain).toBe('album')
    expect(forYou!.items.length).toBeGreaterThanOrEqual(SHELF_MIN_ITEMS)
    expect(forYou!.items.length).toBeLessThanOrEqual(SHELF_ITEM_CAP)
    const names = titles(forYou)
    expect(names.every((title) => /^(Fox|Grove|Hale) Rest /.test(title))).toBe(true)
    expect(names.some((title) => title.includes('Heavy'))).toBe(false)
    expect(names.some((title) => title.startsWith('Alpha'))).toBe(false)
  })

  it('names Alpha on artists and shows the unplayed tail in year order', () => {
    const artists = shelf('artists')
    expect(artists?.title).toBe('Deeper into Alpha')
    expect(titles(artists)).toEqual(['Alpha 3', 'Alpha 4', 'Alpha 5', 'Alpha 6'])
    expect(artists?.items.every((item) => item.why.startsWith('Unplayed'))).toBe(true)
  })

  it('keeps unplayed for what for-you and artists did not claim', () => {
    const leftover = titles(shelf('unplayed'))
    const claimed = new Set([...titles(shelf('for-you')), ...titles(shelf('artists'))])
    expect(leftover.every((title) => !claimed.has(title))).toBe(true)
    expect(leftover.some((title) => title.startsWith('Moss'))).toBe(true)
    expect(leftover.some((title) => title.startsWith('Alpha'))).toBe(false)
  })

  it('puts the long-ago finished albums on revisit, not on for-you', () => {
    const revisit = shelf('revisit')
    expect(revisit?.title).toBe('Worth revisiting')
    expect(titles(revisit).sort()).toEqual(['Echo 1', 'Echo 2', 'Echo 3'])
    expect(titles(shelf('for-you')).some((title) => title.startsWith('Echo'))).toBe(false)
    expect(revisit?.items.every((item) => item.why.startsWith('Last played'))).toBe(true)
  })

  it('caps every shelf', () => {
    for (const entry of result.shelves) {
      expect(entry.items.length).toBeLessThanOrEqual(SHELF_ITEM_CAP)
    }
  })
})

describe('compose — exclusion, cold start, stability', () => {
  it('does not reprint a for-you album on unplayed or revisit', () => {
    const opened = openTempDb()
    seedCatalog(opened.db)
    const result = compose(opened.db, NOW)
    opened.close()

    const forYou = new Set(albumIds(result.shelves.find((shelf) => shelf.id === 'for-you')))
    const unplayed = albumIds(result.shelves.find((shelf) => shelf.id === 'unplayed'))
    const revisit = albumIds(result.shelves.find((shelf) => shelf.id === 'revisit'))
    expect(unplayed.every((id) => !forYou.has(id))).toBe(true)
    expect(revisit.every((id) => !forYou.has(id))).toBe(true)
  })

  it('is byte-identical for the same library, log and nowMs', () => {
    const opened = openTempDb()
    seedCatalog(opened.db)
    const first = compose(opened.db, NOW)
    const second = compose(opened.db, NOW)
    opened.close()
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('keeps the same picks when the UTC day rolls; ties may permute', () => {
    const opened = openTempDb()
    seedCatalog(opened.db)
    const today = compose(opened.db, NOW)
    const tomorrow = compose(opened.db, NOW + DAY_MS)
    opened.close()

    expect(tomorrow.dayKey).toBe('2024-06-16')
    expect(tomorrow.shelves.map((shelf) => shelf.id)).toEqual(
      today.shelves.map((shelf) => shelf.id)
    )
    for (const shelf of today.shelves) {
      const later = tomorrow.shelves.find((entry) => entry.id === shelf.id)
      expect(new Set(titles(later)).size).toBe(new Set(titles(shelf)).size)
      // Scores must not change with the day: the same albums, possibly reordered
      // where the hash was the only difference.
      expect([...titles(later)].sort()).toEqual([...titles(shelf)].sort())
    }
  })

  it('cold-starts as unplayed only, and may render below the usual minimum', () => {
    const opened = openTempDb()
    const rootId = addRoot(opened.db)
    const artist = addArtist(opened.db, 'Solo')
    addCompleteAlbum(opened.db, {
      rootId,
      artistId: artist,
      title: 'One',
      year: 2020,
      genre: 'X',
      tracks: 4
    })
    addCompleteAlbum(opened.db, {
      rootId,
      artistId: artist,
      title: 'Two',
      year: 2021,
      genre: 'Y',
      tracks: 4
    })
    const result = compose(opened.db, NOW)
    opened.close()

    expect(result.shelves.map((shelf) => shelf.id)).toEqual(['unplayed'])
    expect(titles(result.shelves[0]).sort()).toEqual(['One', 'Two'])
    expect(result.shelves[0].items.length).toBeLessThan(SHELF_MIN_ITEMS)
  })

  it('omits for-you / revisit / artists on a listen-less library, not as empty headings', () => {
    const opened = openTempDb()
    const rootId = addRoot(opened.db)
    for (let index = 0; index < 12; index++) {
      addCompleteAlbum(opened.db, {
        rootId,
        artistId: addArtist(opened.db, `Artist ${index}`),
        title: `Album ${index}`,
        year: 2000 + index,
        genre: `G${index % 4}`,
        tracks: 4
      })
    }
    const result = compose(opened.db, NOW)
    opened.close()

    expect(result.shelves.map((shelf) => shelf.id)).toEqual(['unplayed'])
    expect(result.shelves[0].items.length).toBeGreaterThanOrEqual(SHELF_MIN_ITEMS)
  })

  it('cold-starts with forgotten-favorites when hearts exist', () => {
    const opened = openTempDb()
    const rootId = addRoot(opened.db)
    const forgot = addArtist(opened.db, 'Forgot')
    for (let index = 1; index <= 3; index++) {
      const album = addCompleteAlbum(opened.db, {
        rootId,
        artistId: forgot,
        title: `Forgot ${index}`,
        year: 2016,
        genre: 'Forgot',
        tracks: 2
      })
      addFavorite(opened.db, album.trackIds[0]!, NOW - index * DAY_MS)
    }
    for (let index = 0; index < 12; index++) {
      addCompleteAlbum(opened.db, {
        rootId,
        artistId: addArtist(opened.db, `Artist ${index}`),
        title: `Album ${index}`,
        year: 2000 + index,
        genre: `G${index % 4}`,
        tracks: 4
      })
    }
    const result = compose(opened.db, NOW)
    opened.close()

    expect(result.shelves.map((shelf) => shelf.id)).toEqual(['forgotten-favorites', 'unplayed'])
    expect(result.shelves[0].items.length).toBeGreaterThanOrEqual(SHELF_MIN_ITEMS)
  })

  it('memoizes on listen id, favorites, track count and day', () => {
    const opened = openTempDb()
    seedCatalog(opened.db)
    const engine = new DiscoverEngine(opened.db)
    const first = engine.shelves(NOW)
    const second = engine.shelves(NOW)
    expect(second).toBe(first)
    expect(memoKey(opened.db, NOW)).toBe(memoKey(opened.db, NOW))
    expect(memoKey(opened.db, NOW + DAY_MS)).not.toBe(memoKey(opened.db, NOW))
    opened.close()
  })
})

describe('compose — the five extras', () => {
  let close: () => void
  let result: ReturnType<typeof compose>

  beforeAll(() => {
    const opened = openTempDb()
    close = opened.close
    const { rootId } = seedCatalog(opened.db)
    seedExtras(opened.db, rootId)
    result = compose(opened.db, NOW)
  })

  afterAll(() => close())

  function shelf(id: string): DiscoverShelf | undefined {
    return result.shelves.find((entry) => entry.id === id)
  }

  it('runs all ten recipes through one compose call, genre-roulette rendered under for-you', () => {
    // genre-roulette claims last (it takes only what the taste shelves left) but
    // renders second (W12-6): display order is decoupled from the claim walk.
    expect(result.shelves.map((entry) => entry.id)).toEqual([
      'for-you',
      'genre-roulette',
      'artists',
      'almost-finished',
      'forgotten-favorites',
      'because-favorited',
      'guest-appearances',
      'unplayed',
      'neglected-genre',
      'revisit'
    ])
  })

  it('puts holed albums on almost-finished, not on revisit', () => {
    const almost = shelf('almost-finished')
    expect(almost?.title).toBe('Almost finished')
    expect(almost?.hint).toBe('You started these.')
    expect(titles(almost).sort()).toEqual(['Hole 1', 'Hole 2', 'Hole 3'])
    expect(almost?.items.every((item) => item.why === '7 of 10 played')).toBe(true)
    expect(titles(shelf('revisit')).some((title) => title.startsWith('Hole'))).toBe(false)
  })

  it('lists hearted cold tracks on forgotten-favorites', () => {
    const forgotten = shelf('forgotten-favorites')
    expect(forgotten?.title).toBe('Forgotten favorites')
    expect(forgotten?.grain).toBe('track')
    expect(titles(forgotten).sort()).toEqual([
      'Beta 1 01',
      'Forgot 1 01',
      'Forgot 2 01',
      'Forgot 3 01'
    ])
    const whys = forgotten!.items.map((item) => item.why).sort()
    expect(whys).toEqual([
      'Hearted · last played 6 months ago',
      'Hearted · never played',
      'Hearted · never played',
      'Hearted · never played'
    ])
  })

  it('names Beta on because-favorited, not the artists pick', () => {
    expect(shelf('artists')?.title).toBe('Deeper into Alpha')
    const because = shelf('because-favorited')
    expect(because?.title).toBe('Because you favorited Beta')
    expect(because?.hint).toBe('More from an artist you heart.')
    expect(titles(because)).toEqual(['Beta 1', 'Beta 2', 'Beta 3'])
  })

  it('names the ignored library genre on neglected-genre', () => {
    const neglected = shelf('neglected-genre')
    expect(neglected?.title).toBe('Gloam you own and ignore')
    expect(neglected?.hint).toBe('A lot of the library, none of the listening.')
    expect(titles(neglected).every((title) => title.startsWith('Glen'))).toBe(true)
    expect(neglected!.items.length).toBeGreaterThanOrEqual(SHELF_MIN_ITEMS)
  })

  it('credits the seed performer on guest-appearances', () => {
    const guest = shelf('guest-appearances')
    expect(guest?.title).toBe('Guest appearances')
    expect(titles(guest).sort()).toEqual(['Various 1', 'Various 2', 'Various 3'])
    expect(guest?.items.every((item) => item.why === 'Fox appears')).toBe(true)
  })

  it('does not reprint an almost-finished album on revisit', () => {
    const holes = new Set(albumIds(shelf('almost-finished')))
    const revisit = albumIds(shelf('revisit'))
    expect(holes.size).toBe(3)
    expect(revisit.every((id) => !holes.has(id))).toBe(true)
  })
})
