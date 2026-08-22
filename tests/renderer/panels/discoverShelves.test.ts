import { describe, expect, it } from 'vitest'
import type { DiscoverAlbumItem, DiscoverTrackItem } from '../../../src/shared/discover'
import {
  albumPlayParams,
  coverSrc,
  discoverItemKey,
  discoverViewState,
  showPlaceholderBadge,
  type DiscoverView
} from '../../../src/renderer/panels/discoverShelves'

/**
 * Discover's wall, minus its rendering (W12-4, D20).
 *
 * The branch order, the badge and the artwork URL, which are the three
 * things in the pane that can be wrong without looking wrong. All three live
 * outside the `.vue` file so they can be asked about here — `favoriteSongs` is
 * the precedent, and the reason is the same: Vitest runs with no Vue plugin.
 */

function view(overrides: Partial<DiscoverView> = {}): DiscoverView {
  return {
    failed: false,
    answered: true,
    shelfCount: 4,
    ...overrides
  }
}

describe('discoverViewState', () => {
  it('reports a failure over a load, so the retry does not hide its own button', () => {
    expect(discoverViewState(view({ failed: true, answered: false }))).toBe('failed')
  })

  it('is loading until an answer has arrived', () => {
    expect(discoverViewState(view({ answered: false, shelfCount: 0 }))).toBe('loading')
  })

  /**
   * The card's own instruction, held as a test: a real result with no shelves
   * is the designed empty, not four skeleton strips. Zero tracks and a library
   * of singles too thin to qualify look the same here, because the renderer
   * does not count tracks and does not compute recipes.
   */
  it('is empty for a real result with no shelves', () => {
    expect(discoverViewState(view({ shelfCount: 0 }))).toBe('empty')
  })

  it('is shelves for one shelf, including a cold-start unplayed', () => {
    expect(discoverViewState(view({ shelfCount: 1 }))).toBe('shelves')
  })
})

describe('showPlaceholderBadge', () => {
  it('is only for skeleton cards', () => {
    expect(showPlaceholderBadge('loading')).toBe(true)
    expect(showPlaceholderBadge('empty')).toBe(false)
    expect(showPlaceholderBadge('shelves')).toBe(false)
    expect(showPlaceholderBadge('failed')).toBe(false)
  })
})

describe('coverSrc', () => {
  it('addresses a hash the way Library addresses album art', () => {
    expect(coverSrc('abc')).toBe('fermata://artwork/abc/small')
  })
})

describe('discoverItemKey', () => {
  it('is stable per grain and id', () => {
    const album: DiscoverAlbumItem = {
      grain: 'album',
      albumId: 7,
      title: 'Record',
      artist: null,
      year: null,
      trackCount: 8,
      artworkHash: null,
      why: 'Unplayed · 8 tracks'
    }
    const track: DiscoverTrackItem = {
      grain: 'track',
      trackId: 3,
      title: 'Song',
      artist: null,
      albumTitle: null,
      artworkHash: null,
      why: 'Hearted · never played'
    }
    expect(discoverItemKey(album)).toBe('album:7')
    expect(discoverItemKey(track)).toBe('track:3')
  })
})

describe('albumPlayParams', () => {
  it('is Library album activation: one album, disc/track order', () => {
    expect(albumPlayParams(7)).toEqual({
      sort: 'trackNo',
      direction: 'asc',
      filters: { albumIds: [7] }
    })
  })
})
