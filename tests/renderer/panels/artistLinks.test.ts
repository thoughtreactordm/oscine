import { describe, expect, it } from 'vitest'
import type { ArtistLink, ArtistLinksResult } from '@shared/artistLinks'
import {
  buildLinkRows,
  countLinks,
  linkLabel
} from '../../../src/renderer/panels/tunedeck/artistLinks'

/**
 * The rows, and the host each leads with. Pure functions, no DOM.
 *
 * What this file decides is what the deck offers to open and what it calls each
 * link — a hostname derived from the URL rather than a name table that goes
 * stale — so it is worth asserting without mounting a component.
 */

function link(overrides: Partial<ArtistLink> = {}): ArtistLink {
  return { category: 'homepage', url: 'https://artist.example/', ...overrides }
}

function ready(...links: ArtistLink[]): ArtistLinksResult {
  return { artistId: 1, status: 'ready', links, truncated: false, failure: null }
}

describe('linkLabel', () => {
  it('leads with the host and drops the www', () => {
    expect(linkLabel('https://www.instagram.com/artist')).toBe('instagram.com')
    expect(linkLabel('https://artist.bandcamp.com/')).toBe('artist.bandcamp.com')
  })

  it('falls back to the raw string rather than blanking a row', () => {
    expect(linkLabel('not a url')).toBe('not a url')
  })
})

describe('countLinks', () => {
  it('counts the links plainly', () => {
    expect(countLinks(ready(link(), link({ category: 'social' })))).toBe('2')
  })

  it('says nothing rather than zero', () => {
    expect(countLinks(ready())).toBeNull()
    expect(countLinks(null)).toBeNull()
  })
})

describe('buildLinkRows', () => {
  it('draws nothing for a result that is not ready', () => {
    expect(buildLinkRows(null)).toEqual([])
    expect(buildLinkRows({ ...ready(), status: 'none' })).toEqual([])
    expect(buildLinkRows({ ...ready(), status: 'unavailable' })).toEqual([])
  })

  it('emits a header per category and counts what follows it', () => {
    const rows = buildLinkRows(
      ready(
        link({ category: 'homepage', url: 'https://artist.example/' }),
        link({ category: 'social', url: 'https://instagram.com/artist' }),
        link({ category: 'social', url: 'https://twitter.com/artist' })
      )
    )

    expect(
      rows.map((row) => (row.kind === 'header' ? `${row.label}:${row.count}` : row.label))
    ).toEqual(['Official site:1', 'artist.example', 'Social:2', 'instagram.com', 'twitter.com'])
  })

  it('starts a new header only when the category changes', () => {
    const rows = buildLinkRows(
      ready(
        link({ category: 'social', url: 'https://a.example/' }),
        link({ category: 'social', url: 'https://b.example/' })
      )
    )

    expect(rows.filter((row) => row.kind === 'header')).toHaveLength(1)
  })
})
