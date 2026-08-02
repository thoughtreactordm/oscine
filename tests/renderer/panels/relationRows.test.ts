import type {
  ArtistRelation,
  ArtistRelationsResult,
  LibraryArtistMatch
} from '@shared/artistRelations'
import { describe, expect, it } from 'vitest'
import {
  buildRelationRows,
  countOwnedRelations,
  relationDetail,
  relationOwnership,
  relationYears
} from '../../../src/renderer/panels/tunedeck/relationRows'

/**
 * What the pane claims, asserted without a DOM.
 *
 * `artistIdentity.ts`' argument applies twice over here. The interesting output
 * of this module is a set of *sentences* — "3 tracks", "Former members", a
 * comparison-key match marked as uncertain — and every one of them is a claim
 * about the operator's library that they will believe. Mounting a component to
 * read them back would mean a DOM, a Pinia instance and a Nuxt UI plugin
 * standing between the assertion and the string.
 */

const KURT = '956e0a4c-1a58-4bcb-9c8b-8a0d0f7b0b0c'
const DAVE = 'd2b3fbdc-2f6f-4d24-9d2a-f6f0a2d0f0a1'

function match(overrides: Partial<LibraryArtistMatch> = {}): LibraryArtistMatch {
  return { artistId: 7, name: 'Kurt Cobain', trackCount: 3, basis: 'mbid', ...overrides }
}

function relation(overrides: Partial<ArtistRelation> = {}): ArtistRelation {
  return {
    kind: 'member',
    type: 'member of band',
    mbid: KURT,
    name: 'Kurt Cobain',
    disambiguation: null,
    attributes: [],
    begin: null,
    end: null,
    ended: false,
    match: null,
    ...overrides
  }
}

function ready(...relations: ArtistRelation[]): ArtistRelationsResult {
  return { artistId: 1, status: 'ready', relations, truncated: false, failure: null }
}

describe('relationYears', () => {
  it('reduces MusicBrainz partial dates to years', () => {
    expect(relationYears(relation({ begin: '1987-01-01', end: '1994-04-05' }))).toBe('1987–1994')
  })

  it('draws half a range as half a range', () => {
    expect(relationYears(relation({ begin: '1990' }))).toBe('1990–')
    expect(relationYears(relation({ end: '1994', ended: true }))).toBe('–1994')
  })

  it('collapses a range that starts and ends in one year', () => {
    expect(relationYears(relation({ begin: '1992-03', end: '1992-11' }))).toBe('1992')
  })

  it('says nothing about a connection MusicBrainz never dated', () => {
    // Rather than a placeholder dash: an undated former member is still
    // informative, and inventing the missing half would be a claim.
    expect(relationYears(relation())).toBeNull()
  })
})

describe('relationDetail', () => {
  it('leads with instruments and follows with years', () => {
    expect(relationDetail(relation({ attributes: ['guitar', 'lead vocals'], begin: '1987' }))).toBe(
      'guitar, lead vocals · 1987–'
    )
  })

  it('falls back to the disambiguation when there are no attributes', () => {
    expect(relationDetail(relation({ disambiguation: 'US drummer' }))).toBe('US drummer')
  })

  it("never names MusicBrainz's own relationship type", () => {
    // The heading has already said "Members"; repeating "member of band" on
    // every row under it spends the one column that could hold the instruments.
    expect(relationDetail(relation({ type: 'member of band' }))).toBeNull()
    expect(relationDetail(relation({ kind: 'alias', type: 'is person' }))).toBeNull()
  })
})

describe('relationOwnership', () => {
  it('counts what the library holds', () => {
    expect(relationOwnership(relation({ match: match({ trackCount: 3 }) }))).toBe('3 tracks')
    expect(relationOwnership(relation({ match: match({ trackCount: 1 }) }))).toBe('1 track')
  })

  it('says nothing for an artist the library does not hold', () => {
    expect(relationOwnership(relation())).toBeNull()
  })

  it('still reports an artist whose last track has gone', () => {
    // A row with no tracks is the honest answer to a rescan in progress, and it
    // is not the same fact as no row at all.
    expect(relationOwnership(relation({ match: match({ trackCount: 0 }) }))).toBe('In your library')
  })
})

describe('countOwnedRelations', () => {
  it('counts what you own rather than what MusicBrainz knows', () => {
    // The badge answers "is this worth opening", and a band whose entire
    // line-up is absent from the library is a pane the operator can skip.
    const result = ready(relation({ match: match() }), relation({ mbid: DAVE, name: 'Dave Grohl' }))

    expect(countOwnedRelations(result)).toBe('1')
  })

  it('shows nothing rather than a zero', () => {
    expect(countOwnedRelations(ready(relation()))).toBeNull()
    expect(countOwnedRelations(null)).toBeNull()
  })
})

describe('buildRelationRows', () => {
  it('splits a membership into current and former under separate headings', () => {
    const rows = buildRelationRows(
      ready(
        relation({ name: 'Krist Novoselic' }),
        relation({ mbid: DAVE, name: 'Chad Channing', ended: true, end: '1990' })
      )
    )

    expect(rows.map((row) => (row.kind === 'header' ? row.label : row.relation.name))).toEqual([
      'Current line-up',
      'Krist Novoselic',
      'Former members',
      'Chad Channing'
    ])
  })

  it('counts the rows under each heading', () => {
    const rows = buildRelationRows(
      ready(relation({ name: 'A' }), relation({ mbid: DAVE, name: 'B' }))
    )

    expect(rows[0]).toMatchObject({ kind: 'header', count: 2 })
  })

  it('keeps the order main sorted rather than imposing a second one', () => {
    // Two files sorting the same list is how a heading ends up over the wrong
    // rows: section boundaries are read off the sequence, never computed.
    const rows = buildRelationRows(
      ready(
        relation({ kind: 'alias', type: 'is person', name: 'Zeb' }),
        relation({ kind: 'member', mbid: DAVE, name: 'Aaron' })
      )
    )

    expect(rows.map((row) => (row.kind === 'header' ? row.label : row.relation.name))).toEqual([
      'Also known as',
      'Zeb',
      'Current line-up',
      'Aaron'
    ])
  })

  it('marks a name match as uncertain and an identity match as not', () => {
    const rows = buildRelationRows(
      ready(
        relation({ match: match({ basis: 'name' }) }),
        relation({ mbid: DAVE, name: 'Dave Grohl', match: match({ basis: 'mbid' }) })
      )
    )

    expect(rows.filter((row) => row.kind === 'relation').map((row) => row.uncertain)).toEqual([
      true,
      false
    ])
  })

  it('gives two stints by one artist distinct keys', () => {
    // A duplicate `:key` silently drops the second row rather than drawing it,
    // and a member who left and rejoined is legitimately two rows.
    const rows = buildRelationRows(
      ready(
        relation({ begin: '1990', end: '1994', ended: true }),
        relation({ begin: '1997', ended: true })
      )
    )

    const keys = rows.filter((row) => row.kind === 'relation').map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('draws nothing for a result that is not ready', () => {
    expect(buildRelationRows(null)).toEqual([])
    expect(
      buildRelationRows({
        artistId: 1,
        status: 'none',
        relations: [],
        truncated: false,
        failure: null
      })
    ).toEqual([])
  })
})
