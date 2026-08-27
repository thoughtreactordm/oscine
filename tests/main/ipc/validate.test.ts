import { describe, expect, it } from 'vitest'
import { OscineError } from '@shared/errors'
import {
  MAX_FAVORITE_IDS_PAGE,
  MAX_FAVORITE_REMOVE_IDS,
  MAX_FAVORITE_STATE_IDS,
  MAX_FAVORITES_PAGE
} from '@shared/favorites'
import { DISCOVER_RECIPE_IDS } from '@shared/discover'
import {
  MAX_FACET_ID_PAGE,
  MAX_FACET_PAGE,
  MAX_FILTER_IDS,
  MAX_ORDERED_TRACK_IDS,
  MAX_SEARCH_LENGTH,
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE
} from '@shared/library'
import { MAX_STATS_BUCKETS, MAX_STATS_ROWS } from '@shared/stats'
import {
  assertCancelNetScopeRequest,
  assertClearArtistMbidRequest,
  assertSearchArtistCandidatesRequest,
  assertSetArtistMbidRequest,
  assertExportPlaylistRequest,
  assertListFacetIdsQuery,
  assertListFacetsQuery,
  assertListTrackIdsQuery,
  assertListTracksQuery,
  assertGetTracksByIdsQuery,
  assertFavoriteStateRequest,
  assertListFavoriteIdsQuery,
  assertListFavoritesQuery,
  assertOpenExternalRequest,
  assertOrderTrackIdsQuery,
  assertRemoveFavoritesRequest,
  assertSaveDiscoverShelfRequest,
  assertStatsOverTimeQuery,
  assertStatsQuery,
  assertStatsSummaryQuery,
  assertToggleFavoriteRequest
} from '../../../src/main/ipc/validate'

describe('library browse IPC validation', () => {
  it('accepts and normalizes a fully composed track query', () => {
    expect(
      assertListTracksQuery({
        rootId: 1,
        artistIds: [2, 5, 2],
        albumIds: [3],
        searchText: '  hemian  ',
        sort: 'album',
        direction: 'desc',
        offset: 10,
        limit: 20
      })
    ).toEqual({
      rootId: 1,
      // Deduplicated, because a selection assembled from overlapping ranges can
      // honestly repeat an id and the repeat changes no result.
      artistIds: [2, 5],
      albumIds: [3],
      searchText: 'hemian',
      sort: 'album',
      direction: 'desc',
      offset: 10,
      limit: 20
    })
  })

  it('rejects malformed ids, short searches and unbounded windows', () => {
    const base = { offset: 0, limit: 20 }
    for (const query of [
      { ...base, artistIds: [0] },
      { ...base, albumIds: [1.5] },
      { ...base, artistIds: 2 },
      // Empty is refused rather than read as "match everything" or "match
      // nothing" — the two readings differ by the whole library.
      { ...base, albumIds: [] },
      {
        ...base,
        artistIds: Array.from({ length: MAX_FILTER_IDS + 1 }, (_, index) => index + 1)
      },
      { ...base, searchText: 'ab' },
      { ...base, searchText: 'a b c' },
      { ...base, searchText: 'x'.repeat(MAX_SEARCH_LENGTH + 1) },
      { ...base, limit: MAX_FACET_PAGE + 1 },
      { ...base, surprise: true }
    ]) {
      expect(() => assertListFacetsQuery(query)).toThrow(OscineError)
    }

    expect(() =>
      assertListTracksQuery({
        sort: 'title',
        direction: 'asc',
        offset: 0,
        limit: MAX_TRACK_PAGE + 1
      })
    ).toThrow(OscineError)
  })

  it('accepts and deduplicates a tagKeys dimension, rejecting malformed ones', () => {
    // W15-5 — the genre/tag browse dimension is a string set, deduplicated like
    // the id sets and taken verbatim (main does not re-fold the keys).
    expect(
      assertListTracksQuery({
        tagKeys: ['rock', 'jazz', 'rock'],
        sort: 'title',
        direction: 'asc',
        offset: 0,
        limit: 20
      }).tagKeys
    ).toEqual(['rock', 'jazz'])

    const base = { sort: 'title', direction: 'asc', offset: 0, limit: 20 } as const
    for (const tagKeys of [[], [''], [42], 'rock']) {
      expect(() => assertListTracksQuery({ ...base, tagKeys })).toThrow(OscineError)
    }
  })

  it('lets an id page be larger than a row page, but not unbounded', () => {
    const query = { sort: 'title', direction: 'asc', offset: 0 } as const

    // The extra headroom is the reason the channel exists.
    expect(assertListTrackIdsQuery({ ...query, limit: MAX_TRACK_PAGE + 1 }).limit).toBe(
      MAX_TRACK_PAGE + 1
    )
    expect(assertListTrackIdsQuery({ ...query, limit: MAX_TRACK_ID_PAGE }).limit).toBe(
      MAX_TRACK_ID_PAGE
    )
    expect(() => assertListTrackIdsQuery({ ...query, limit: MAX_TRACK_ID_PAGE + 1 })).toThrow(
      OscineError
    )
  })

  it('lets a facet id page be larger than a facet row page', () => {
    // Wide enough that any selection a user can make resolves in one request.
    expect(assertListFacetIdsQuery({ offset: 0, limit: MAX_FACET_ID_PAGE }).limit).toBe(
      MAX_FACET_ID_PAGE
    )
    expect(() => assertListFacetsQuery({ offset: 0, limit: MAX_FACET_PAGE + 1 })).toThrow(
      OscineError
    )
    expect(() => assertListFacetIdsQuery({ offset: 0, limit: MAX_FACET_ID_PAGE + 1 })).toThrow(
      OscineError
    )
  })

  it('holds a row-widening request to the row-page ceiling, not the id one', () => {
    expect(assertGetTracksByIdsQuery({ ids: [3, 1, 2] })).toEqual({ ids: [3, 1, 2] })
    // Duplicates survive: the up-next queue may legitimately hold one track
    // twice, and it is the caller's sequence that is being widened.
    expect(assertGetTracksByIdsQuery({ ids: [7, 7] }).ids).toEqual([7, 7])
    expect(assertGetTracksByIdsQuery({ ids: [] }).ids).toEqual([])

    for (const query of [
      { ids: 5 },
      { ids: [1, 'two'] },
      { ids: [1, 0] },
      { ids: [1, 2.5] },
      { ids: [1], sort: 'title' },
      { ids: Array.from({ length: MAX_TRACK_PAGE + 1 }, (_, index) => index + 1) }
    ]) {
      expect(() => assertGetTracksByIdsQuery(query)).toThrow(OscineError)
    }
  })

  it('validates every id in a selection to be ordered', () => {
    expect(assertOrderTrackIdsQuery({ sort: 'artist', direction: 'desc', ids: [3, 1, 2] })).toEqual(
      { sort: 'artist', direction: 'desc', ids: [3, 1, 2] }
    )
    expect(assertOrderTrackIdsQuery({ sort: 'title', direction: 'asc', ids: [] }).ids).toEqual([])

    for (const query of [
      { sort: 'title', direction: 'asc', ids: 5 },
      { sort: 'title', direction: 'asc', ids: [1, 'two'] },
      { sort: 'title', direction: 'asc', ids: [1, 0] },
      { sort: 'title', direction: 'asc', ids: [1, 2.5] },
      { sort: 'title', direction: 'asc', ids: [1], offset: 0 },
      { sort: 'nowhere', direction: 'asc', ids: [1] },
      { sort: 'title', direction: 'sideways', ids: [1] },
      {
        sort: 'title',
        direction: 'asc',
        ids: Array.from({ length: MAX_ORDERED_TRACK_IDS + 1 }, (_, index) => index + 1)
      }
    ]) {
      expect(() => assertOrderTrackIdsQuery(query)).toThrow(OscineError)
    }
  })

  it('accepts either export path style and rejects anything else', () => {
    expect(assertExportPlaylistRequest({ playlistId: 3, pathStyle: 'relative' })).toEqual({
      playlistId: 3,
      pathStyle: 'relative'
    })
    expect(assertExportPlaylistRequest({ playlistId: 3, pathStyle: 'absolute' })).toEqual({
      playlistId: 3,
      pathStyle: 'absolute'
    })

    for (const request of [
      { playlistId: 3 },
      { playlistId: 3, pathStyle: 'RELATIVE' },
      { playlistId: 3, pathStyle: 'file://' },
      { playlistId: 0, pathStyle: 'relative' },
      // An unknown field is a caller that thinks it is configuring something.
      { playlistId: 3, pathStyle: 'relative', destination: '/etc/passwd' }
    ]) {
      expect(() => assertExportPlaylistRequest(request)).toThrow(OscineError)
    }
  })

  it('does not accept FTS syntax as a way around literal text validation', () => {
    // Quotes and operators remain ordinary characters after validation. The
    // store wraps the whole value as one escaped FTS phrase.
    expect(
      assertListFacetsQuery({
        searchText: 'hemian" OR title:*',
        offset: 0,
        limit: 20
      }).searchText
    ).toBe('hemian" OR title:*')
  })
})

describe('favorites IPC validation', () => {
  it('takes one positive integer to toggle and nothing else', () => {
    expect(assertToggleFavoriteRequest({ trackId: 42 })).toEqual({ trackId: 42 })

    for (const request of [
      {},
      { trackId: 0 },
      { trackId: -1 },
      { trackId: 1.5 },
      { trackId: '42' },
      // A field this build does not know about is a request written against a
      // different contract. Accepting it silently is how the two stop matching.
      { trackId: 42, favorite: true }
    ]) {
      expect(() => assertToggleFavoriteRequest(request)).toThrow(OscineError)
    }
  })

  it('holds a batch state lookup to the id-page ceiling', () => {
    expect(assertFavoriteStateRequest({ trackIds: [3, 1, 2] })).toEqual({ trackIds: [3, 1, 2] })
    expect(assertFavoriteStateRequest({ trackIds: [] }).trackIds).toEqual([])
    // Duplicates pass validation and the store collapses them: this is a
    // question about a set, and rejecting a repeated id would make the caller
    // dedupe a list it is about to hand over anyway.
    expect(assertFavoriteStateRequest({ trackIds: [7, 7] }).trackIds).toEqual([7, 7])
    expect(
      assertFavoriteStateRequest({
        trackIds: Array.from({ length: MAX_FAVORITE_STATE_IDS }, (_, index) => index + 1)
      }).trackIds
    ).toHaveLength(MAX_FAVORITE_STATE_IDS)

    for (const request of [
      { trackIds: 5 },
      { trackIds: [1, 'two'] },
      { trackIds: [1, 0] },
      { trackIds: [1, 2.5] },
      { trackIds: [1], offset: 0 },
      { trackIds: Array.from({ length: MAX_FAVORITE_STATE_IDS + 1 }, (_, index) => index + 1) }
    ]) {
      expect(() => assertFavoriteStateRequest(request)).toThrow(OscineError)
    }
  })

  it('takes a window for the list and refuses an ordering it cannot express', () => {
    expect(assertListFavoritesQuery({ offset: 0, limit: 50 })).toEqual({ offset: 0, limit: 50 })

    for (const query of [
      { offset: 0 },
      { limit: 50 },
      { offset: -1, limit: 50 },
      { offset: 0, limit: 0 },
      { offset: 0, limit: MAX_FAVORITES_PAGE + 1 },
      // D18 gives this collection one order. A sort parameter here would be an
      // ordering the store has no column to express.
      { offset: 0, limit: 50, sort: 'title' },
      { offset: 0, limit: 50, searchText: 'reich' }
    ]) {
      expect(() => assertListFavoritesQuery(query)).toThrow(OscineError)
    }
  })

  /**
   * The ids half of the same window, an order of magnitude wider because the
   * response is integers rather than the display projection — the same trade
   * `listTrackIds` makes against `listTracks`.
   */
  it('takes the same window for the ids, at the id-page ceiling', () => {
    expect(assertListFavoriteIdsQuery({ offset: 0, limit: MAX_FAVORITE_IDS_PAGE })).toEqual({
      offset: 0,
      limit: MAX_FAVORITE_IDS_PAGE
    })

    for (const query of [
      { offset: 0 },
      { limit: 50 },
      { offset: 0, limit: MAX_FAVORITE_IDS_PAGE + 1 },
      { offset: 0, limit: 50, sort: 'title' }
    ]) {
      expect(() => assertListFavoriteIdsQuery(query)).toThrow(OscineError)
    }
  })

  it('holds the batch removal to the same ceiling as the batch lookup', () => {
    expect(assertRemoveFavoritesRequest({ trackIds: [3, 1, 2] })).toEqual({ trackIds: [3, 1, 2] })
    expect(assertRemoveFavoritesRequest({ trackIds: [] }).trackIds).toEqual([])
    // Duplicates pass and the store collapses them, as they do for the lookup:
    // a selection assembled from overlapping ranges can honestly repeat an id.
    expect(assertRemoveFavoritesRequest({ trackIds: [7, 7] }).trackIds).toEqual([7, 7])

    for (const request of [
      { trackIds: 5 },
      { trackIds: [1, 'two'] },
      { trackIds: [1, 0] },
      { trackIds: [1], favorite: false },
      { trackIds: Array.from({ length: MAX_FAVORITE_REMOVE_IDS + 1 }, (_, index) => index + 1) }
    ]) {
      expect(() => assertRemoveFavoritesRequest(request)).toThrow(OscineError)
    }
  })
})

describe('net scope IPC validation', () => {
  it('accepts a scope the build knows how to cancel', () => {
    expect(assertCancelNetScopeRequest({ scope: 'tunedeck' })).toEqual({ scope: 'tunedeck' })
    expect(assertCancelNetScopeRequest({ scope: 'scrobble' })).toEqual({ scope: 'scrobble' })
  })

  it('refuses an unknown scope rather than cancelling nothing quietly', () => {
    // The failure mode this guards: a typo'd scope leaves in-flight requests
    // running with nothing to signal it, which is invisible from either side.
    for (const request of [
      { scope: 'tunedck' },
      { scope: '' },
      { scope: 'Tunedeck' },
      { scope: 7 },
      {},
      // An unknown field is a caller that thinks it is configuring something.
      { scope: 'tunedeck', force: true }
    ]) {
      expect(() => assertCancelNetScopeRequest(request)).toThrow(OscineError)
    }
  })
})

describe('open-external IPC validation', () => {
  it('accepts http and https URLs, normalised', () => {
    expect(assertOpenExternalRequest({ url: 'https://ui.nuxt.com' })).toEqual({
      url: 'https://ui.nuxt.com/'
    })
    expect(assertOpenExternalRequest({ url: 'http://example.org/docs' })).toEqual({
      url: 'http://example.org/docs'
    })
  })

  it('refuses any non-web scheme so the renderer cannot reach the shell', () => {
    // The whole point of the guard: `shell.openExternal` will launch `file:`,
    // `mailto:` and worse, and the renderer is the last place that should decide
    // which scheme is safe.
    for (const url of [
      'file:///etc/passwd',
      'mailto:a@b.c',
      'javascript:alert(1)',
      'oscine://track/1',
      'not a url',
      '',
      'ftp://example.org'
    ]) {
      expect(() => assertOpenExternalRequest({ url })).toThrow(OscineError)
    }
  })

  it('refuses a non-string url and unexpected fields', () => {
    expect(() => assertOpenExternalRequest({ url: 7 })).toThrow(OscineError)
    expect(() => assertOpenExternalRequest({})).toThrow(OscineError)
    expect(() => assertOpenExternalRequest({ url: 'https://ok.dev', target: '_blank' })).toThrow(
      OscineError
    )
  })
})

describe('discover save-shelf IPC validation', () => {
  it('accepts every recipe in the 1.0 catalog', () => {
    for (const recipeId of DISCOVER_RECIPE_IDS) {
      expect(assertSaveDiscoverShelfRequest({ recipeId })).toEqual({ recipeId })
    }
  })

  it('refuses an unknown recipe rather than saving nothing quietly', () => {
    for (const request of [
      { recipeId: 'for-yu' },
      { recipeId: 'recently-added' },
      { recipeId: '' },
      { recipeId: 7 },
      {},
      { recipeId: 'for-you', force: true }
    ]) {
      expect(() => assertSaveDiscoverShelfRequest(request)).toThrow(OscineError)
    }
  })
})

describe('artist identity IPC validation', () => {
  const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'

  it('accepts a chosen identity', () => {
    expect(assertSetArtistMbidRequest({ artistId: 3, mbid: MBID })).toEqual({
      artistId: 3,
      mbid: MBID
    })
  })

  /**
   * "None of these" is a value and not an omission. `assertOnlyKeys` already
   * rejects a caller that dropped the field, so the two cannot be confused.
   */
  it('accepts an explicit null as the operator saying "none of these"', () => {
    expect(assertSetArtistMbidRequest({ artistId: 3, mbid: null })).toEqual({
      artistId: 3,
      mbid: null
    })
    expect(() => assertSetArtistMbidRequest({ artistId: 3 })).toThrow(OscineError)
  })

  /**
   * The format check is here rather than only in the service because this value
   * becomes durable: an MBID that is not a UUID would sit on the row looking
   * like a resolved artist whose biography merely never loads.
   */
  it('refuses anything that is not a MusicBrainz identifier', () => {
    for (const mbid of [
      'not-a-uuid',
      '5B11F4CE-A62D-471E-81FC-A69A8278C7DA',
      `${MBID} `,
      `${MBID}${MBID}`,
      '',
      7
    ]) {
      expect(() => assertSetArtistMbidRequest({ artistId: 3, mbid })).toThrow(OscineError)
    }
  })

  it('refuses a bad artist id, and an unexpected field', () => {
    for (const request of [
      { artistId: 0, mbid: MBID },
      { artistId: -1, mbid: MBID },
      { artistId: 1.5, mbid: MBID },
      { artistId: '3', mbid: MBID },
      { artistId: 3, mbid: MBID, source: 'manual' }
    ]) {
      expect(() => assertSetArtistMbidRequest(request)).toThrow(OscineError)
    }
  })

  it('validates the two by-artist requests the same way', () => {
    expect(assertSearchArtistCandidatesRequest({ artistId: 3 })).toEqual({ artistId: 3 })
    expect(assertClearArtistMbidRequest({ artistId: 3 })).toEqual({ artistId: 3 })
    expect(() => assertSearchArtistCandidatesRequest({ artistId: 3, force: true })).toThrow(
      OscineError
    )
    expect(() => assertClearArtistMbidRequest({})).toThrow(OscineError)
  })
})

describe('stats IPC validation', () => {
  const RANGE = { from: 1_700_000_000_000, to: 1_700_086_400_000 }

  it('takes a closed range and refuses an inverted or partial one', () => {
    expect(assertStatsSummaryQuery({ range: RANGE, scope: null })).toEqual({
      range: RANGE,
      scope: null
    })
    // The epoch is a legal instant, and "all time" is a range that starts
    // before any listen — which a renderer is entitled to spell as zero.
    expect(assertStatsSummaryQuery({ range: { from: 0, to: 0 }, scope: null })).toEqual({
      range: { from: 0, to: 0 },
      scope: null
    })

    for (const range of [
      {},
      { from: 1 },
      { to: 1 },
      { from: -1, to: 1 },
      { from: 1.5, to: 2 },
      { from: '1', to: 2 },
      // Inverted rather than empty: a preset computed wrong, and returning zero
      // rows for it would hide the bug behind a dashboard that looks quiet.
      { from: 2, to: 1 },
      { from: 1, to: 2, bucket: 'day' }
    ]) {
      expect(() => assertStatsSummaryQuery({ range, scope: null })).toThrow(OscineError)
    }
  })

  it('takes a scope of a track id and one of three words, and requires the field', () => {
    for (const by of ['track', 'album', 'artist']) {
      expect(assertStatsSummaryQuery({ range: RANGE, scope: { trackId: 7, by } })).toEqual({
        range: RANGE,
        scope: { trackId: 7, by }
      })
    }

    for (const scope of [
      // Absent, not `null`. The difference between the deck's numbers and the
      // library's is this one field, and a caller that forgot it would get the
      // whole log's play count drawn as one track's — wrong without looking it.
      undefined,
      { by: 'artist' },
      { trackId: 7 },
      { trackId: 7, by: 'genre' },
      { trackId: 0, by: 'track' },
      { trackId: -1, by: 'track' },
      { trackId: 1.5, by: 'track' },
      { trackId: 7, by: 'track', range: RANGE }
    ]) {
      expect(() => assertStatsSummaryQuery({ range: RANGE, scope })).toThrow(OscineError)
    }
  })

  it('validates a ranking against the dimension and sort tuples', () => {
    const query = { range: RANGE, dimension: 'artist', sort: 'time', limit: 25, offset: 50 }
    expect(assertStatsQuery(query)).toEqual(query)

    for (const dimension of ['track', 'album', 'artist', 'genre']) {
      expect(assertStatsQuery({ ...query, dimension }).dimension).toBe(dimension)
    }

    for (const bad of [
      { ...query, dimension: 'year' },
      { ...query, dimension: undefined },
      { ...query, sort: 'plays' },
      // No default: both totals are reported and neither is chosen for the
      // operator, so the caller has to say which one orders the list.
      { range: RANGE, dimension: 'track', limit: 10, offset: 0 },
      { ...query, range: { from: 2, to: 1 } },
      { ...query, offset: -1 },
      { ...query, limit: 0 },
      { ...query, limit: MAX_STATS_ROWS + 1 },
      { ...query, bucket: 'day' }
    ]) {
      expect(() => assertStatsQuery(bad)).toThrow(OscineError)
    }
  })

  it('refuses a range and bucket that would produce too many points', () => {
    const day = 86_400_000
    const from = 1_700_000_000_000

    expect(
      assertStatsOverTimeQuery({ range: { from, to: from + 30 * day }, bucket: 'day' })
    ).toEqual({ range: { from, to: from + 30 * day }, bucket: 'day' })

    // Neither end is invalid alone — a decade is a fair thing to ask about and
    // an hour is a fair width. Their quotient is what the response costs.
    expect(() =>
      assertStatsOverTimeQuery({ range: { from, to: from + 3650 * day }, bucket: 'day' })
    ).not.toThrow()
    expect(() =>
      assertStatsOverTimeQuery({ range: { from, to: from + 3650 * day }, bucket: 'hour' })
    ).toThrow(OscineError)

    // Exactly at the ceiling passes; one bucket past it does not.
    const hour = 3_600_000
    const edge = { from, to: from + (MAX_STATS_BUCKETS - 1) * hour }
    expect(() => assertStatsOverTimeQuery({ range: edge, bucket: 'hour' })).not.toThrow()
    expect(() =>
      assertStatsOverTimeQuery({ range: { from, to: edge.to + hour }, bucket: 'hour' })
    ).toThrow(OscineError)

    for (const bad of [
      { range: { from, to: from + day } },
      { range: { from, to: from + day }, bucket: 'month' },
      { range: { from, to: from + day }, bucket: 'day', limit: 10 }
    ]) {
      expect(() => assertStatsOverTimeQuery(bad)).toThrow(OscineError)
    }
  })
})
