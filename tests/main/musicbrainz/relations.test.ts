import { describe, expect, it } from 'vitest'
import {
  ARTIST_RELATIONS_INC,
  artistRelationsUrl,
  parseArtistRelations,
  relationKind,
  relationsCacheKey
} from '../../../src/main/musicbrainz/relations'

/**
 * The document, parsed. Nothing here opens a socket.
 *
 * The two things worth asserting are the direction handling and the defensive
 * parse. Direction decides which *end* of a relationship we are standing at, and
 * getting it backwards would put a drummer's own bands under a heading that says
 * "Members" — wrong in a way that reads as authoritative, which is the failure
 * mode R5 is about. The defensive parse is the same argument `search.ts` makes:
 * a half-filled relation must cost its own row and nothing else.
 */

const KURT = '956e0a4c-1a58-4bcb-9c8b-8a0d0f7b0b0c'
const DAVE = 'd2b3fbdc-2f6f-4d24-9d2a-f6f0a2d0f0a1'
const NIRVANA = '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6'

interface Relation {
  type?: string
  direction?: string
  'target-type'?: string
  artist?: Record<string, unknown>
  attributes?: unknown
  begin?: string | null
  end?: string | null
  ended?: boolean
}

function document(...relations: Relation[]): unknown {
  return { id: NIRVANA, name: 'Nirvana', relations }
}

function member(overrides: Relation = {}): Relation {
  return {
    type: 'member of band',
    direction: 'backward',
    'target-type': 'artist',
    artist: { id: KURT, name: 'Kurt Cobain', disambiguation: 'Nirvana' },
    attributes: ['guitar'],
    begin: '1987',
    end: null,
    ended: false,
    ...overrides
  }
}

describe('relationKind', () => {
  it('reads a membership from whichever end asked', () => {
    // The band's own page lists people; the person's page lists bands. One
    // MusicBrainz relationship, two headings.
    expect(relationKind('member of band', 'backward')).toBe('member')
    expect(relationKind('member of band', 'forward')).toBe('group')
  })

  it('puts a subgroup under side projects and its parent under groups', () => {
    expect(relationKind('subgroup', 'forward')).toBe('side-project')
    expect(relationKind('subgroup', 'backward')).toBe('group')
  })

  it('treats collaborations and aliases as symmetric', () => {
    expect(relationKind('collaboration', 'forward')).toBe('collaboration')
    expect(relationKind('collaboration', 'backward')).toBe('collaboration')
    expect(relationKind('is person', 'forward')).toBe('alias')
    expect(relationKind('legal name', 'backward')).toBe('alias')
  })

  it('declines a type the pane has no heading for', () => {
    // MusicBrainz records `sibling`, `teacher`, `married` and thirty more. Every
    // one is a fact about two people rather than about their music, and the pane
    // is a 380px column that has better things to spend a row on.
    expect(relationKind('sibling', 'forward')).toBeNull()
    expect(relationKind('teacher', null)).toBeNull()
  })
})

describe('parseArtistRelations', () => {
  it('reads a membership', () => {
    const [relation] = parseArtistRelations(document(member()))

    expect(relation).toMatchObject({
      kind: 'member',
      type: 'member of band',
      mbid: KURT,
      name: 'Kurt Cobain',
      disambiguation: 'Nirvana',
      attributes: ['guitar'],
      begin: '1987',
      ended: false
    })
  })

  it('ignores relations to anything that is not an artist', () => {
    // An artist document carries relations to release groups, works, places and
    // series. This pane is about artists.
    const parsed = parseArtistRelations(
      document(member(), {
        type: 'composer',
        'target-type': 'work',
        artist: undefined
      })
    )

    expect(parsed).toHaveLength(1)
  })

  it('drops a relation whose type the pane does not draw', () => {
    // Dropped at the parse rather than filtered later, so nothing downstream
    // has to know the vocabulary a second time.
    const parsed = parseArtistRelations(
      document(member(), member({ type: 'sibling', artist: { id: DAVE, name: 'A Sibling' } }))
    )

    expect(parsed.map((relation) => relation.name)).toEqual(['Kurt Cobain'])
  })

  it('drops a relation with no usable identifier or name', () => {
    const parsed = parseArtistRelations(
      document(
        member({ artist: { id: 'not-a-uuid', name: 'Nobody' } }),
        member({ artist: { id: DAVE } }),
        member()
      )
    )

    expect(parsed.map((relation) => relation.mbid)).toEqual([KURT])
  })

  it('reads an end date as an ended relationship even without the flag', () => {
    // MusicBrainz sets `ended`, but a dated relation that has not had it set is
    // the same fact and a former member drawn as a current one is a wrong claim.
    const [relation] = parseArtistRelations(
      document(member({ end: '1990', ended: false, artist: { id: DAVE, name: 'Chad Channing' } }))
    )

    expect(relation?.ended).toBe(true)
  })

  it('merges one stint split across several relationships', () => {
    const parsed = parseArtistRelations(
      document(
        member({ attributes: ['guitar'] }),
        member({ attributes: ['lead vocals'] }),
        member({ attributes: ['guitar'] })
      )
    )

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.attributes).toEqual(['guitar', 'lead vocals'])
  })

  it('keeps two stints apart', () => {
    // A member who left and rejoined is two date ranges and stays two rows.
    const parsed = parseArtistRelations(
      document(
        member({ artist: { id: DAVE, name: 'Dave Grohl' }, begin: '1990', end: '1994' }),
        member({ artist: { id: DAVE, name: 'Dave Grohl' }, begin: '1997', end: null })
      )
    )

    expect(parsed).toHaveLength(2)
  })

  it('answers a document with no relations at all with nothing', () => {
    expect(parseArtistRelations({ id: NIRVANA })).toEqual([])
    expect(parseArtistRelations(null)).toEqual([])
    expect(parseArtistRelations('nirvana')).toEqual([])
  })
})

describe('addressing', () => {
  it('asks for artist relations and nothing else', () => {
    const url = artistRelationsUrl(NIRVANA)

    expect(url).toContain(`/artist/${NIRVANA}`)
    expect(url).toContain(`inc=${ARTIST_RELATIONS_INC}`)
    expect(url).toContain('fmt=json')
  })

  it('names the inc in the cache key', () => {
    // `musicbrainz.artist` holds two documents from one endpoint. A key of the
    // bare MBID would let a relations-only reply answer a request that wanted
    // the outbound links too.
    expect(relationsCacheKey(NIRVANA)).toBe(`${NIRVANA}/${ARTIST_RELATIONS_INC}`)
  })
})
