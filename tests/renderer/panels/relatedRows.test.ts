import { describe, expect, it } from 'vitest'
import {
  albumMeta,
  buildRelatedRows,
  countRelatedRows
} from '../../../src/renderer/panels/tunedeck/relatedRows'
import type { Track } from '../../../src/shared/library'
import type {
  RelatedAlbum,
  RelatedResult,
  RelatedSection,
  RelatedStrand
} from '../../../src/shared/related'

/**
 * The related pane's flattening, tested without a browser.
 *
 * The pane's virtualization rests on one property this module owns: every row
 * it emits is the same height, so `visibleRange` can stay arithmetic. The tests
 * that matter here are therefore about what becomes a row and in what order —
 * the heights are a constant in the component, but the *count* of rows is what
 * the spacers are computed from, and a duplicate key or a swallowed section is
 * a scroll position that does not match what is drawn.
 */

function album(
  albumId: number,
  title: string,
  overrides: Partial<RelatedAlbum> = {}
): RelatedAlbum {
  return { albumId, title, artist: 'Artist', year: 1998, trackCount: 9, ...overrides }
}

function track(id: number, title: string): Track {
  return {
    id,
    rootId: 1,
    title,
    artist: 'Artist',
    album: 'Album',
    albumArtist: 'Artist',
    trackNo: id,
    discNo: null,
    year: 1998,
    durationSec: 200,
    codec: 'flac',
    encodedBytes: 1000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    favorite: false,
    modified: false,
    artwork: { small: '', large: '' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

function result(sections: RelatedSection[]): RelatedResult {
  return { seedTrackId: 1, sections }
}

describe('albumMeta', () => {
  it('reads artist, year and track count', () => {
    expect(albumMeta(album(1, 'A'))).toBe('Artist · 1998 · 9 tracks')
  })

  it('singularises a one-track album', () => {
    expect(albumMeta(album(1, 'A', { trackCount: 1 }))).toBe('Artist · 1998 · 1 track')
  })

  it('drops what the tags never said rather than rendering a placeholder', () => {
    // The row is thirty-six pixels; a dash standing in for an unknown year is
    // worth less than the space it takes.
    expect(albumMeta(album(1, 'A', { artist: null, year: null }))).toBe('9 tracks')
  })
})

/** The six strands as the deck's three groups now split them. */
const ARTIST: readonly RelatedStrand[] = ['artist-albums', 'compilations']
const ALBUM: readonly RelatedStrand[] = ['album-tracks']
const NEIGHBOURHOOD: readonly RelatedStrand[] = ['genre', 'year', 'folder']
const ALL: readonly RelatedStrand[] = [...ARTIST, ...ALBUM, ...NEIGHBOURHOOD]

/** One result carrying a section from each half, for the filtering tests. */
function mixed(): RelatedResult {
  return result([
    {
      kind: 'tracks',
      strand: 'album-tracks',
      detail: 'Album',
      truncated: false,
      tracks: [track(1, 'One')]
    },
    {
      kind: 'albums',
      strand: 'artist-albums',
      detail: 'Artist',
      truncated: false,
      albums: [album(2, 'B')]
    },
    {
      kind: 'albums',
      strand: 'genre',
      detail: 'IDM',
      truncated: false,
      albums: [album(3, 'C')]
    }
  ])
}

describe('buildRelatedRows', () => {
  it('is empty for no result at all', () => {
    expect(buildRelatedRows(null, ALL)).toEqual([])
  })

  it('emits a heading row before each section', () => {
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'artist-albums',
          detail: 'Artist',
          truncated: false,
          albums: [album(1, 'A')]
        }
      ]),
      ARTIST
    )
    expect(rows.map((row) => row.kind)).toEqual(['header', 'album'])
  })

  it('draws only the strands the group asked for', () => {
    // The query still answers all six in one round trip; the split is in the
    // drawing. A group that leaked a strand from another tab would put "same
    // year" under Artist, which is the merge the tabs exist to undo.
    expect(buildRelatedRows(mixed(), ARTIST).map((row) => row.key)).toEqual([
      'header:artist-albums',
      'album:artist-albums:2'
    ])
    expect(buildRelatedRows(mixed(), ALBUM).map((row) => row.key)).toEqual([
      'header:album-tracks',
      'track:1'
    ])
    expect(buildRelatedRows(mixed(), NEIGHBOURHOOD).map((row) => row.key)).toEqual([
      'header:genre',
      'album:genre:3'
    ])
  })

  it('accounts for every row exactly once across the three groups', () => {
    // The three groups partition the six strands. A strand in neither list is
    // one the operator can no longer reach; a strand in two is one they see
    // twice under different headings.
    const whole = buildRelatedRows(mixed(), ALL).map((row) => row.key)
    const split = [ARTIST, ALBUM, NEIGHBOURHOOD].flatMap((strands) =>
      buildRelatedRows(mixed(), strands).map((row) => row.key)
    )
    expect([...split].sort()).toEqual([...whole].sort())
  })

  it('emits nothing at all for a group whose strands did not answer', () => {
    // Distinct from "no result": the query ran and this group is simply empty,
    // which is what the component's own empty state says.
    expect(buildRelatedRows(mixed(), ['folder'])).toEqual([])
  })

  it('keys album rows by strand as well as by album', () => {
    // The same album is legitimately both a record by the artist and a 1998
    // record — and a duplicate `:key` silently drops the second row.
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'artist-albums',
          detail: null,
          truncated: false,
          albums: [album(7, 'Same')]
        },
        {
          kind: 'albums',
          strand: 'year',
          detail: '1998',
          truncated: false,
          albums: [album(7, 'Same')]
        }
      ]),
      ALL
    )
    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('marks a truncated section with a trailing plus', () => {
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'genre',
          detail: 'IDM',
          truncated: true,
          albums: [album(1, 'A'), album(2, 'B')]
        }
      ]),
      NEIGHBOURHOOD
    )
    const header = rows.find((row) => row.kind === 'header')
    expect(header?.kind === 'header' && header.count).toBe('2+')
  })

  it('reports an exact count when the section is complete', () => {
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'genre',
          detail: 'IDM',
          truncated: false,
          albums: [album(1, 'A'), album(2, 'B')]
        }
      ]),
      NEIGHBOURHOOD
    )
    const header = rows.find((row) => row.kind === 'header')
    expect(header?.kind === 'header' && header.count).toBe('2')
  })

  it('preserves the order the strands arrived in', () => {
    // The result's section order is authoritative, not the group's strand list
    // — otherwise the same two strands could read in two orders.
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'compilations',
          detail: 'Artist',
          truncated: false,
          albums: [album(9, 'Comp')]
        },
        {
          kind: 'albums',
          strand: 'artist-albums',
          detail: 'Artist',
          truncated: false,
          albums: [album(8, 'Solo')]
        }
      ]),
      ['artist-albums', 'compilations']
    )
    expect(rows.map((row) => row.key)).toEqual([
      'header:compilations',
      'album:compilations:9',
      'header:artist-albums',
      'album:artist-albums:8'
    ])
  })
})

describe('countRelatedRows', () => {
  it('counts items and not the headings above them', () => {
    // The badge answers "is this worth opening". Counting heading rows would
    // report three albums as six.
    expect(countRelatedRows(mixed(), NEIGHBOURHOOD)).toBe('1')
    expect(countRelatedRows(mixed(), ALL)).toBe('3')
  })

  it('is null rather than zero for a group with nothing in it', () => {
    // A zero on a header is noisier than a bare header, and the absence of a
    // badge already says the same thing.
    expect(countRelatedRows(mixed(), ['folder'])).toBeNull()
    expect(countRelatedRows(null, ALL)).toBeNull()
  })

  it('carries the plus through from a capped strand', () => {
    // A capped strand reported as exact is the badge quietly lying about how
    // much is behind the header.
    const capped = result([
      {
        kind: 'albums',
        strand: 'genre',
        detail: 'IDM',
        truncated: true,
        albums: [album(1, 'A'), album(2, 'B')]
      },
      {
        kind: 'albums',
        strand: 'year',
        detail: '1998',
        truncated: false,
        albums: [album(3, 'C')]
      }
    ])
    expect(countRelatedRows(capped, NEIGHBOURHOOD)).toBe('3+')
  })
})
