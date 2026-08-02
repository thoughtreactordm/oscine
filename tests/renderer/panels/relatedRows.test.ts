import { describe, expect, it } from 'vitest'
import { albumMeta, buildRelatedRows } from '../../../src/renderer/panels/tunedeck/relatedRows'
import type { Track } from '../../../src/shared/library'
import type { RelatedAlbum, RelatedResult, RelatedSection } from '../../../src/shared/related'

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

describe('buildRelatedRows', () => {
  it('is empty for no result at all', () => {
    expect(buildRelatedRows(null)).toEqual([])
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
      ])
    )
    expect(rows.map((row) => row.kind)).toEqual(['header', 'album'])
  })

  it('emits the group divider once, before the first neighbourhood section', () => {
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'artist-albums',
          detail: null,
          truncated: false,
          albums: [album(1, 'A')]
        },
        {
          kind: 'albums',
          strand: 'genre',
          detail: 'IDM',
          truncated: false,
          albums: [album(2, 'B')]
        },
        {
          kind: 'albums',
          strand: 'year',
          detail: '1998',
          truncated: false,
          albums: [album(3, 'C')]
        }
      ])
    )
    expect(rows.filter((row) => row.kind === 'group')).toHaveLength(1)
    expect(rows.map((row) => row.kind)).toEqual([
      'header',
      'album',
      'group',
      'header',
      'album',
      'header',
      'album'
    ])
  })

  it('emits the divider even when there is no catalog half above it', () => {
    // A track with only neighbourhood relations still needs the caveat — the
    // rule is "before the first one" rather than "between the halves".
    const rows = buildRelatedRows(
      result([
        {
          kind: 'albums',
          strand: 'genre',
          detail: 'IDM',
          truncated: false,
          albums: [album(1, 'A')]
        }
      ])
    )
    expect(rows[0].kind).toBe('group')
  })

  it('emits no divider when there is no neighbourhood half', () => {
    const rows = buildRelatedRows(
      result([
        {
          kind: 'tracks',
          strand: 'album-tracks',
          detail: 'Album',
          truncated: false,
          tracks: [track(1, 'T')]
        }
      ])
    )
    expect(rows.some((row) => row.kind === 'group')).toBe(false)
  })

  it('keys album rows by strand as well as by album', () => {
    // The same album is legitimately both a 1998 record by the artist and a
    // 1998 record — and a duplicate `:key` silently drops the second row.
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
      ])
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
      ])
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
      ])
    )
    const header = rows.find((row) => row.kind === 'header')
    expect(header?.kind === 'header' && header.count).toBe('2')
  })

  it('preserves the order the strands arrived in', () => {
    const rows = buildRelatedRows(
      result([
        {
          kind: 'tracks',
          strand: 'album-tracks',
          detail: 'Album',
          truncated: false,
          tracks: [track(1, 'One'), track(2, 'Two')]
        },
        {
          kind: 'albums',
          strand: 'compilations',
          detail: 'Artist',
          truncated: false,
          albums: [album(9, 'Comp')]
        }
      ])
    )
    expect(rows.map((row) => row.key)).toEqual([
      'header:album-tracks',
      'track:1',
      'track:2',
      'header:compilations',
      'album:compilations:9'
    ])
  })
})
