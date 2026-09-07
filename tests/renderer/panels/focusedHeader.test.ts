import { describe, expect, it } from 'vitest'
import {
  albumDetail,
  albumsLabel,
  artistDetail,
  focusKind,
  genreDetail,
  genreOrigin,
  tracksLabel,
  type BrowseFocus
} from '../../../src/renderer/panels/focusedHeader'

function browse(patch: Partial<BrowseFocus> = {}): BrowseFocus {
  return { albumIds: undefined, artistIds: undefined, tagKeys: undefined, ...patch }
}

describe('focusKind', () => {
  it('is absent when nothing is selected', () => {
    expect(focusKind(browse())).toBeNull()
  })

  it('names a single genre', () => {
    expect(focusKind(browse({ tagKeys: ['jazz'] }))).toBe('genre')
  })

  it('names a single artist, even under a genre', () => {
    expect(focusKind(browse({ tagKeys: ['jazz'], artistIds: [7] }))).toBe('artist')
  })

  it('names a single album as the tightest source', () => {
    expect(focusKind(browse({ artistIds: [7], albumIds: [3] }))).toBe('album')
  })

  it('refuses a multi-select at the tightest dimension', () => {
    expect(focusKind(browse({ tagKeys: ['jazz', 'rock'] }))).toBeNull()
    expect(focusKind(browse({ artistIds: [1, 2] }))).toBeNull()
    expect(focusKind(browse({ artistIds: [1], albumIds: [3, 4] }))).toBeNull()
  })

  it('does not fall back to a looser singular source past a multi-select', () => {
    expect(focusKind(browse({ tagKeys: ['jazz'], artistIds: [1, 2] }))).toBeNull()
  })
})

describe('meta copy', () => {
  it('pluralises tracks and albums', () => {
    expect(tracksLabel(1)).toBe('1 track')
    expect(tracksLabel(148)).toBe('148 tracks')
    expect(albumsLabel(1)).toBe('1 album')
    expect(albumsLabel(12)).toBe('12 albums')
  })

  it('joins artist albums and tracks, dropping an unknown album count', () => {
    expect(artistDetail({ albumCount: 12, trackCount: 148 })).toBe('12 albums · 148 tracks')
    expect(artistDetail({ albumCount: 0, trackCount: 3 })).toBe('3 tracks')
    expect(artistDetail({ albumCount: null, trackCount: null })).toBe('')
  })

  it('joins album artist, year and tracks the way a grouped header does', () => {
    expect(albumDetail({ albumArtist: 'Talk Talk', year: 1988, trackCount: 8 })).toBe(
      'Talk Talk · 1988 · 8 tracks'
    )
    expect(albumDetail({ albumArtist: null, year: null, trackCount: 1 })).toBe('1 track')
  })

  it('names a genre’s origin the way the Tags pane splits vocabularies', () => {
    expect(genreOrigin({ hasFile: true, hasUser: false })).toBe('From files')
    expect(genreOrigin({ hasFile: false, hasUser: true })).toBe('Your tag')
    expect(genreOrigin({ hasFile: true, hasUser: true })).toBe('From files and your tags')
    expect(genreOrigin({ hasFile: false, hasUser: false })).toBeNull()
    expect(genreDetail({ hasFile: true, hasUser: false, trackCount: 40 })).toBe(
      'From files · 40 tracks'
    )
  })
})
