import { afterEach, describe, expect, it } from 'vitest'
import { neglectedGenre } from '../../../../src/main/library/discover/recipes/neglectedGenre'
import { buildTasteSeed } from '../../../../src/main/library/discover/seed'
import { emptyClaimed } from '../../../../src/main/library/discover/types'
import { DAY_MS } from '../../../../src/main/library/discover/constants'
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

/**
 * W15-6: the neglected-genre recipe treats a user tag as a first-class genre
 * key. A key the operator only ever hand-applied — never carried by a file — is
 * both pickable as the ignored genre and matchable as the shelf's albums.
 */
describe('neglectedGenre widened to user tags (W15-6)', () => {
  let close: () => void

  afterEach(() => {
    close?.()
  })

  it('builds a shelf from a large, unplayed, tag-only key', () => {
    const opened = openTempDb()
    close = opened.close
    const { db } = opened
    const rootId = addRoot(db)

    // A played album so the seed is not a cold start. Its genre is what the
    // seed's recent-listen keys exclude from the neglect pool.
    const heard = addArtist(db, 'Heard')
    const heardAlbum = addCompleteAlbum(db, {
      rootId,
      artistId: heard,
      title: 'Heard',
      year: 2020,
      genre: 'Seedgenre',
      tracks: 4
    })
    listenEveryTrack(db, heardAlbum.trackIds, NOW - 3 * DAY_MS)

    // Five unplayed albums carrying only the user tag 'Workout' — no file genre.
    // Twenty tagged tracks make 'workout' the largest key in the library, and
    // nobody has played any of them, so it is exactly what the shelf means.
    for (let index = 1; index <= 5; index++) {
      const artist = addArtist(db, `Gym ${index}`)
      const album = addCompleteAlbum(db, {
        rootId,
        artistId: artist,
        title: `Gym ${index}`,
        year: 2015,
        genre: '',
        tracks: 4
      })
      tagTracks(db, 'Workout', album.trackIds)
    }
    rebuild(db)

    const seed = buildTasteSeed(db, NOW)
    const output = neglectedGenre(db, NOW, emptyClaimed(), seed)

    expect(output).not.toBeNull()
    expect(output!.title).toBe('Workout you own and ignore')
    expect(output!.items.every((item) => item.title.startsWith('Gym'))).toBe(true)
  })
})
