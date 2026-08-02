import { describe, expect, it } from 'vitest'
import { searchQuery } from '../../../src/main/musicbrainz/artistName'
import {
  CORROBORATION_ALBUM_LIMIT,
  parseReleaseGroupSearch,
  releaseGroupCacheKey,
  releaseGroupQuery,
  releaseGroupSearchUrl
} from '../../../src/main/musicbrainz/releaseGroups'
import { corroborate, countCorroboration, decide } from '../../../src/main/musicbrainz/score'
import { parseArtistSearch } from '../../../src/main/musicbrainz/search'
import { rankCandidates } from '../../../src/main/musicbrainz/service'
import {
  LED_ZEPPELIN,
  LED_ZEPPELIN_RELEASE_GROUPS,
  NIRVANA,
  TRIBUTE_RELEASE_GROUPS
} from './fixtures'

/**
 * R5's third test, against the case that made it necessary.
 *
 * The header assertion is the first one: Led Zeppelin is `ambiguous` on names
 * alone. That is not a contrived fixture — it is a live reply, and the same is
 * true of Pink Floyd, The Beatles and Radiohead. Every famous artist has a
 * tribute act whose name is one bigram away, so the name score ties and the
 * verdict falls onto a quarter-weighted relevance figure that cannot carry it.
 *
 * Everything after that is about the ways corroboration must *decline* to
 * decide, which is the half that keeps R5's rule intact.
 */

const LIBRARY = ['Led Zeppelin IV', 'Houses of the Holy']

function ledZeppelin(): ReturnType<typeof rankCandidates> {
  return rankCandidates(searchQuery('Led Zeppelin'), parseArtistSearch(LED_ZEPPELIN))
}

describe('the case corroboration exists for', () => {
  it('cannot settle Led Zeppelin on names alone', () => {
    const candidates = ledZeppelin()
    expect(decide(candidates).kind).toBe('ambiguous')

    // The arithmetic, so a future tuning change has to look at it: an exact
    // match at 100 against a tribute act at 91, and the margin wants ten.
    expect(candidates[0]?.name).toBe('Led Zeppelin')
    expect(candidates[1]?.name).toBe('Led Zeppelin2')
    expect(candidates[0]!.score - candidates[1]!.score).toBeLessThan(10)
  })

  it('settles it on the albums the library already holds', () => {
    const credited = countCorroboration(
      LIBRARY,
      parseReleaseGroupSearch(LED_ZEPPELIN_RELEASE_GROUPS)
    )
    const verdict = corroborate(ledZeppelin(), credited)

    expect(verdict.kind).toBe('accept')
    expect(verdict.kind === 'accept' && verdict.match.mbid).toBe(
      '678d88b2-87b0-403b-b63d-5da7465aecc3'
    )
  })

  it('counts albums we own, not release groups MusicBrainz returned', () => {
    // Five rows come back and only two are the records we hold. Counting rows
    // would make one album look like four, which matters the moment a second
    // candidate is credited with a genuine one.
    const credited = countCorroboration(
      LIBRARY,
      parseReleaseGroupSearch(LED_ZEPPELIN_RELEASE_GROUPS)
    )
    expect(credited.get('678d88b2-87b0-403b-b63d-5da7465aecc3')).toBe(2)
  })

  it('does not count an anthology as the album it anthologises', () => {
    const credited = countCorroboration(
      ['Led Zeppelin IV'],
      parseReleaseGroupSearch(LED_ZEPPELIN_RELEASE_GROUPS)
    )
    // "Anthology of Led Zeppelin IV" and "In the Studio: Led Zeppelin IV" are
    // both returned and neither is the record.
    expect(credited.get('678d88b2-87b0-403b-b63d-5da7465aecc3')).toBe(1)
  })

  it('reads through the punctuation MusicBrainz brackets a title with', () => {
    // The live reply calls it "[Led Zeppelin IV]" — the album has no official
    // title, so MusicBrainz brackets a conventional one.
    const credited = countCorroboration(
      ['Led Zeppelin IV'],
      [{ title: '[Led Zeppelin IV]', artistMbids: ['x'] }]
    )
    expect(credited.get('x')).toBe(1)
  })
})

describe('when corroboration declines to decide', () => {
  it('stays ambiguous when nothing is corroborated', () => {
    expect(corroborate(ledZeppelin(), new Map()).kind).toBe('ambiguous')
  })

  it('stays ambiguous when two candidates are equally corroborated', () => {
    // A split MusicBrainz entry, or a self-titled record two acts both made.
    // R5 hands this to the operator rather than guessing.
    const tie = new Map([
      ['678d88b2-87b0-403b-b63d-5da7465aecc3', 2],
      ['93fc2072-7796-4c60-b937-4e724168e0a1', 2]
    ])
    expect(corroborate(ledZeppelin(), tie).kind).toBe('ambiguous')
  })

  it('accepts the leader when it is strictly ahead', () => {
    const lead = new Map([
      ['678d88b2-87b0-403b-b63d-5da7465aecc3', 2],
      ['93fc2072-7796-4c60-b937-4e724168e0a1', 1]
    ])
    const verdict = corroborate(ledZeppelin(), lead)
    expect(verdict.kind === 'accept' && verdict.match.name).toBe('Led Zeppelin')
  })

  it('will follow the evidence to a tribute act', () => {
    // Deliberate. If MusicBrainz credits the record we hold to "Led Zeppelin2",
    // then either the tag or MusicBrainz is wrong and this layer cannot tell
    // which — but it is above the threshold and it is the only thing corroborated,
    // so guessing the *other* one would be preferring the name score we already
    // established cannot separate them. The picker remains one click away.
    const credited = countCorroboration(LIBRARY, parseReleaseGroupSearch(TRIBUTE_RELEASE_GROUPS))
    const verdict = corroborate(ledZeppelin(), credited)
    expect(verdict.kind === 'accept' && verdict.match.name).toBe('Led Zeppelin2')
  })

  it('never promotes a candidate that failed the threshold', () => {
    // The rescue this must not become. Nirvana's candidates are all exact name
    // matches, so instead: corroboration naming an MBID nobody scored well.
    const candidates = rankCandidates('Something Else Entirely', parseArtistSearch(NIRVANA))
    expect(candidates.every((candidate) => candidate.score < 80)).toBe(true)

    const credited = new Map(candidates.map((candidate) => [candidate.mbid, 3]))
    expect(corroborate(candidates, credited).kind).toBe('ambiguous')
  })

  it('is ambiguous rather than accepting when there are no candidates at all', () => {
    expect(corroborate([], new Map([['x', 5]])).kind).toBe('ambiguous')
  })
})

describe('the request', () => {
  it('quotes every title so a phrase is not three optional words', () => {
    // Unquoted, "Houses of the Holy" matches any release group containing "of",
    // which corroborates everybody.
    expect(releaseGroupQuery('Led Zeppelin', LIBRARY)).toBe(
      'artist:"Led Zeppelin" AND (releasegroup:"Led Zeppelin IV" OR releasegroup:"Houses of the Holy")'
    )
  })

  it('escapes Lucene syntax on both sides', () => {
    const query = releaseGroupQuery('Sunn O)))', ['White1'])
    expect(query).toContain('Sunn O\\)\\)\\)')
  })

  it('is null when there is nothing to corroborate with', () => {
    // A release-group search with no title clause matches the artist's whole
    // discography, which corroborates whoever the name search already favoured.
    expect(releaseGroupQuery('Led Zeppelin', [])).toBeNull()
    expect(releaseGroupQuery('Led Zeppelin', ['  '])).toBeNull()
    expect(releaseGroupQuery('  ', LIBRARY)).toBeNull()
  })

  it('asks for JSON at the release-group endpoint', () => {
    const url = new URL(releaseGroupSearchUrl('artist:"x"'))
    expect(url.pathname).toBe('/ws/2/release-group')
    expect(url.searchParams.get('fmt')).toBe('json')
    expect(url.searchParams.get('query')).toBe('artist:"x"')
  })

  it('keeps four albums, which is what the store is asked for', () => {
    expect(CORROBORATION_ALBUM_LIMIT).toBe(4)
  })

  it('caches on the titles regardless of the order they were ranked in', () => {
    // The store ranks albums by track count, so one more play can reorder two of
    // them. Without this the reordering costs a request to receive the same reply.
    expect(releaseGroupCacheKey('Led Zeppelin', ['Houses of the Holy', 'Led Zeppelin IV'])).toBe(
      releaseGroupCacheKey('led zeppelin', ['Led Zeppelin IV', 'Houses of the Holy'])
    )
  })
})

describe('parsing a release-group reply', () => {
  it('keeps the title and every artist credited', () => {
    expect(
      parseReleaseGroupSearch({
        'release-groups': [
          {
            title: 'Watch the Throne',
            'artist-credit': [
              { artist: { id: 'a', name: 'Jay-Z' } },
              { artist: { id: 'b', name: 'Kanye West' } }
            ]
          }
        ]
      })
    ).toEqual([{ title: 'Watch the Throne', artistMbids: ['a', 'b'] }])
  })

  it('lets one release group vote once per artist', () => {
    expect(
      parseReleaseGroupSearch({
        'release-groups': [
          {
            title: 'A Remix',
            'artist-credit': [{ artist: { id: 'a' } }, { artist: { id: 'a' } }]
          }
        ]
      })
    ).toEqual([{ title: 'A Remix', artistMbids: ['a'] }])
  })

  it('drops entries that cannot corroborate anything', () => {
    expect(
      parseReleaseGroupSearch({
        'release-groups': [
          { title: 'No Credit' },
          { 'artist-credit': [{ artist: { id: 'a' } }] },
          { title: 'Empty Credit', 'artist-credit': [] },
          { title: 'No Id', 'artist-credit': [{ artist: { name: 'Anonymous' } }] }
        ]
      })
    ).toEqual([])
    expect(parseReleaseGroupSearch(null)).toEqual([])
    expect(parseReleaseGroupSearch({ error: 'busy' })).toEqual([])
  })
})
