import { describe, expect, it } from 'vitest'
import {
  ARTIST_URL_RELATIONS_INC,
  artistUrlRelationsUrl,
  linkCategory,
  parseArtistUrlRelations,
  urlRelationsCacheKey
} from '../../../src/main/musicbrainz/urlRelations'

/**
 * The url-rels half of the document, parsed. Nothing here opens a socket.
 *
 * The two things worth asserting are the closed category table and the scheme
 * guard. The table decides which URLs the pane offers to open at all, and the
 * guard decides that every one it does offer is safe to hand `shell.openExternal`
 * — a `javascript:` resource that slipped through would be an open-anything
 * primitive rather than a bad row, which is the failure this parse exists to
 * stop before the renderer ever sees the URL.
 */

const NIRVANA = '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6'

interface Relation {
  type?: string
  direction?: string
  'target-type'?: string
  url?: Record<string, unknown>
}

function document(...relations: Relation[]): unknown {
  return { id: NIRVANA, name: 'Nirvana', relations }
}

function link(type: string, resource: string): Relation {
  return { type, direction: 'forward', 'target-type': 'url', url: { resource } }
}

describe('linkCategory', () => {
  it('maps the four the pane draws', () => {
    expect(linkCategory('official homepage')).toBe('homepage')
    expect(linkCategory('bandcamp')).toBe('bandcamp')
    expect(linkCategory('purchase for download')).toBe('purchase')
    expect(linkCategory('purchase for mail order')).toBe('purchase')
    expect(linkCategory('social network')).toBe('social')
  })

  it('declines a URL type the pane has no heading for', () => {
    // Discogs, Wikidata, VIAF, allmusic and the rest are catalogue
    // cross-references rather than places a listener goes next. Dropped at the
    // parse rather than bucketed, so the pane never fills with authority control.
    expect(linkCategory('discogs')).toBeNull()
    expect(linkCategory('wikidata')).toBeNull()
    expect(linkCategory('streaming')).toBeNull()
  })
})

describe('parseArtistUrlRelations', () => {
  it('reads an outbound link', () => {
    const [parsed] = parseArtistUrlRelations(
      document(link('official homepage', 'https://nirvana.com/'))
    )

    expect(parsed).toEqual({ category: 'homepage', url: 'https://nirvana.com/' })
  })

  it('ignores relations to anything that is not a URL', () => {
    const parsed = parseArtistUrlRelations(
      document(link('official homepage', 'https://nirvana.com/'), {
        type: 'member of band',
        'target-type': 'artist'
      })
    )

    expect(parsed).toHaveLength(1)
  })

  it('drops a URL type the pane does not draw', () => {
    const parsed = parseArtistUrlRelations(
      document(
        link('official homepage', 'https://nirvana.com/'),
        link('discogs', 'https://www.discogs.com/artist/125246')
      )
    )

    expect(parsed.map((entry) => entry.category)).toEqual(['homepage'])
  })

  it('refuses a resource with a scheme other than http or https', () => {
    // The gate every URL passes before the renderer hands it to
    // `shell.openExternal`. `file:` and `javascript:` are launchable and hostile,
    // and MusicBrainz is edited by the public.
    const parsed = parseArtistUrlRelations(
      document(
        link('official homepage', 'javascript:alert(1)'),
        link('official homepage', 'file:///etc/passwd'),
        link('official homepage', 'not a url'),
        link('bandcamp', 'https://nirvana.bandcamp.com/')
      )
    )

    expect(parsed).toEqual([{ category: 'bandcamp', url: 'https://nirvana.bandcamp.com/' }])
  })

  it('finds the Bandcamp link the acceptance criterion names', () => {
    const parsed = parseArtistUrlRelations(
      document(link('bandcamp', 'https://anartist.bandcamp.com/'))
    )

    expect(parsed).toContainEqual({
      category: 'bandcamp',
      url: 'https://anartist.bandcamp.com/'
    })
  })

  it('draws one address once when MusicBrainz files it under two types', () => {
    // A Bandcamp page also tagged as the official homepage is one row, not two
    // under two headings. First category wins after the sort orders them.
    const parsed = parseArtistUrlRelations(
      document(
        link('official homepage', 'https://nirvana.bandcamp.com/'),
        link('bandcamp', 'https://nirvana.bandcamp.com/')
      )
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.category).toBe('homepage')
  })

  it('orders the links homepage, bandcamp, purchase, then socials', () => {
    const parsed = parseArtistUrlRelations(
      document(
        link('social network', 'https://instagram.com/artist'),
        link('purchase for download', 'https://store.example/artist'),
        link('bandcamp', 'https://artist.bandcamp.com/'),
        link('official homepage', 'https://artist.example/')
      )
    )

    expect(parsed.map((entry) => entry.category)).toEqual([
      'homepage',
      'bandcamp',
      'purchase',
      'social'
    ])
  })

  it('answers a document with no relations at all with nothing', () => {
    expect(parseArtistUrlRelations({ id: NIRVANA })).toEqual([])
    expect(parseArtistUrlRelations(null)).toEqual([])
    expect(parseArtistUrlRelations('nirvana')).toEqual([])
  })
})

describe('addressing', () => {
  it('asks for url relations and nothing else', () => {
    const url = artistUrlRelationsUrl(NIRVANA)

    expect(url).toContain(`/artist/${NIRVANA}`)
    expect(url).toContain(`inc=${ARTIST_URL_RELATIONS_INC}`)
    expect(url).toContain('fmt=json')
  })

  it('names the inc in the cache key so it cannot collide with the members document', () => {
    expect(urlRelationsCacheKey(NIRVANA)).toBe(`${NIRVANA}/${ARTIST_URL_RELATIONS_INC}`)
    expect(urlRelationsCacheKey(NIRVANA)).not.toBe(`${NIRVANA}/artist-rels`)
  })
})
