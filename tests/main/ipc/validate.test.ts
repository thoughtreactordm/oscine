import { describe, expect, it } from 'vitest'
import { FermataError } from '@shared/errors'
import {
  MAX_FACET_ID_PAGE,
  MAX_FACET_PAGE,
  MAX_FILTER_IDS,
  MAX_ORDERED_TRACK_IDS,
  MAX_SEARCH_LENGTH,
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE
} from '@shared/library'
import {
  assertExportPlaylistRequest,
  assertListFacetIdsQuery,
  assertListFacetsQuery,
  assertListTrackIdsQuery,
  assertListTracksQuery,
  assertOrderTrackIdsQuery
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
      expect(() => assertListFacetsQuery(query)).toThrow(FermataError)
    }

    expect(() =>
      assertListTracksQuery({
        sort: 'title',
        direction: 'asc',
        offset: 0,
        limit: MAX_TRACK_PAGE + 1
      })
    ).toThrow(FermataError)
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
      FermataError
    )
  })

  it('lets a facet id page be larger than a facet row page', () => {
    // Wide enough that any selection a user can make resolves in one request.
    expect(assertListFacetIdsQuery({ offset: 0, limit: MAX_FACET_ID_PAGE }).limit).toBe(
      MAX_FACET_ID_PAGE
    )
    expect(() => assertListFacetsQuery({ offset: 0, limit: MAX_FACET_PAGE + 1 })).toThrow(
      FermataError
    )
    expect(() => assertListFacetIdsQuery({ offset: 0, limit: MAX_FACET_ID_PAGE + 1 })).toThrow(
      FermataError
    )
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
      expect(() => assertOrderTrackIdsQuery(query)).toThrow(FermataError)
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
      expect(() => assertExportPlaylistRequest(request)).toThrow(FermataError)
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
