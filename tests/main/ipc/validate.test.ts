import { describe, expect, it } from 'vitest'
import { FermataError } from '@shared/errors'
import { MAX_FACET_PAGE, MAX_SEARCH_LENGTH, MAX_TRACK_PAGE } from '@shared/library'
import { assertListFacetsQuery, assertListTracksQuery } from '../../../src/main/ipc/validate'

describe('library browse IPC validation', () => {
  it('accepts and normalizes a fully composed track query', () => {
    expect(
      assertListTracksQuery({
        rootId: 1,
        artistId: 2,
        albumId: 3,
        searchText: '  hemian  ',
        sort: 'album',
        direction: 'desc',
        offset: 10,
        limit: 20
      })
    ).toEqual({
      rootId: 1,
      artistId: 2,
      albumId: 3,
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
      { ...base, artistId: 0 },
      { ...base, albumId: 1.5 },
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
