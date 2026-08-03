import { describe, expect, it } from 'vitest'
import type { ArtistFavoritesResult } from '@shared/favorites'
import type { Track } from '@shared/library'
import {
  countArtistFavorites,
  favoriteSongsState,
  type FavoriteSongsView
} from '../../../src/renderer/panels/tunedeck/favoriteSongs'

/**
 * The deck's Favorite Songs pane, minus its rendering (W10-8, D18).
 *
 * The badge and the branch order, which are the two things in the pane that can
 * be wrong without looking wrong. Both live outside the `.vue` file precisely so
 * they can be asked about here — see `relatedRows.test.ts` for the precedent.
 */

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Track ${id}`,
    artist: 'An Artist',
    album: null,
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationSec: null,
    codec: null,
    encodedBytes: 0,
    sampleRateHz: null,
    channels: null,
    bitDepth: null,
    playCount: 0,
    lastPlayedAt: null,
    favorite: true,
    artwork: { small: '', large: '' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

function result(count: number, truncated = false): ArtistFavoritesResult {
  return {
    seedTrackId: 1,
    artistId: 7,
    tracks: Array.from({ length: count }, (_, index) => track(index + 1)),
    truncated
  }
}

/** A pane that has an answer with rows in it. Each test perturbs one field. */
function view(overrides: Partial<FavoriteSongsView> = {}): FavoriteSongsView {
  return {
    seedId: 1,
    loading: false,
    failed: false,
    answered: true,
    artistId: 7,
    count: 3,
    ...overrides
  }
}

describe('countArtistFavorites', () => {
  it('counts the rows', () => {
    expect(countArtistFavorites(result(4))).toBe('4')
  })

  /**
   * `null` and not `'0'`. The badge answers "is it worth opening", which a bare
   * heading answers in the negative at least as well — and the three states that
   * produce no number are not worth three different zeroes.
   */
  it('is nothing at all for an artist with no favorites', () => {
    expect(countArtistFavorites(result(0))).toBeNull()
  })

  it('is nothing at all before an answer has arrived', () => {
    expect(countArtistFavorites(null)).toBeNull()
  })

  /** A capped answer is never reported as an exact one. */
  it('carries the truncation through as a +', () => {
    expect(countArtistFavorites(result(50, true))).toBe('50+')
  })
})

describe('favoriteSongsState', () => {
  it('draws the rows when there are rows', () => {
    expect(favoriteSongsState(view())).toBe('rows')
  })

  it('stands down when nothing is playing', () => {
    expect(favoriteSongsState(view({ seedId: null }))).toBe('standby')
  })

  /**
   * `standby` outranks everything, including a failure carried over from the
   * track that was playing a moment ago. A deck with no track has nothing to
   * retry and nothing to be empty of.
   */
  it('stands down over a stale failure', () => {
    expect(favoriteSongsState(view({ seedId: null, failed: true }))).toBe('standby')
  })

  /**
   * `failed` outranks `loading`, because the retry re-enters `loading` — a pane
   * that said "Looking…" during its own retry would hide the button the operator
   * had just reached for twice.
   */
  it('keeps the failure visible while its own retry is in flight', () => {
    expect(favoriteSongsState(view({ failed: true, loading: true }))).toBe('failed')
  })

  it('is loading while the query runs', () => {
    expect(favoriteSongsState(view({ loading: true, answered: false, count: 0 }))).toBe('loading')
  })

  /**
   * The flash this ordering exists to prevent. Between a track change and the
   * answer there is a seed, no rows and no artist — which is indistinguishable
   * from an empty artist on the fields alone, so `answered` is what separates
   * them. Without it every track change shows the invitation for a frame.
   */
  it('does not flash the empty state before the first answer', () => {
    expect(
      favoriteSongsState(view({ loading: false, answered: false, artistId: null, count: 0 }))
    ).toBe('loading')
  })

  it('says there is no artist when the track named none', () => {
    expect(favoriteSongsState(view({ artistId: null, count: 0 }))).toBe('nameless')
  })

  /**
   * The state the card is mostly about, and it is a peer of `rows` rather than a
   * branch under a failure: an artist with no favorites is the ordinary answer
   * over a large library.
   */
  it('is empty — not failed — for an artist with no favorites', () => {
    expect(favoriteSongsState(view({ count: 0 }))).toBe('empty')
  })
})
