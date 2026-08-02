import { describe, expect, it } from 'vitest'
import { searchQuery } from '../../../src/main/musicbrainz/artistName'
import {
  ARTIST_MATCH_MARGIN,
  ARTIST_MATCH_THRESHOLD,
  decide,
  type ScoredCandidate
} from '../../../src/main/musicbrainz/score'
import { parseArtistSearch } from '../../../src/main/musicbrainz/search'
import { rankCandidates } from '../../../src/main/musicbrainz/service'
import {
  ABSENT,
  BEATLES,
  EMPTY,
  DAFT_PUNK,
  GODSPEED,
  MALFORMED,
  NIRVANA,
  SAKAMOTO,
  type SearchDocument
} from './fixtures'

/**
 * **R5**'s acceptance, as a table: correct resolution across a fixture set
 * chosen to be hard.
 *
 * This is the test the threshold is tuned against. Every case runs the whole
 * decision — query construction, parsing, scoring, the threshold and the margin
 * — because those four are only correct together: a query that keeps the
 * featured-artist trailer scores every candidate badly, and a scorer that
 * cannot read an alias rejects an artist the search found first.
 */

/** The verdict, plus the arithmetic that produced it, for one tag string. */
function resolve(
  tag: string,
  document: SearchDocument
): { verdict: ReturnType<typeof decide>; ranked: ScoredCandidate[]; query: string } {
  const query = searchQuery(tag)
  const ranked = rankCandidates(query, parseArtistSearch(document))
  return { verdict: decide(ranked), ranked, query }
}

describe('R5 fixture set', () => {
  /**
   * The case the whole card is built around. Eleven artists are called
   * "Nirvana"; three is enough to prove the point. Every one is an exact match,
   * so the margin is what refuses to guess — and refusing is the correct answer,
   * because a confident wrong biography is worse than none.
   */
  it('declines to pick between identically named artists', () => {
    const { verdict, ranked } = resolve('Nirvana', NIRVANA)

    expect(verdict.kind).toBe('ambiguous')
    // Not because they scored badly — because they scored the same.
    expect(ranked[0].score).toBeGreaterThanOrEqual(ARTIST_MATCH_THRESHOLD)
    expect(ranked[0].score - ranked[1].score).toBeLessThan(ARTIST_MATCH_MARGIN)
    // And the picker has something to show, with the line that tells them apart.
    expect(ranked).toHaveLength(3)
    expect(ranked.map((c) => c.disambiguation)).toContain('1980s–1990s US grunge band')
  })

  it('resolves a name whose punctuation the tag dropped', () => {
    const { verdict, ranked } = resolve('Godspeed You Black Emperor', GODSPEED)

    expect(verdict.kind).toBe('accept')
    expect(ranked[0].name).toBe('Godspeed You! Black Emperor')
    expect(ranked[0].nameScore).toBe(100)
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(ARTIST_MATCH_MARGIN)
  })

  it('resolves a non-Latin name through its alias and inverted sort name', () => {
    const { verdict, ranked } = resolve('Ryuichi Sakamoto', SAKAMOTO)

    expect(verdict.kind).toBe('accept')
    expect(ranked[0].mbid).toBe('e0e1ce9c-2ec9-4d0c-9d3d-1a5b0d3a0f2b')
    // The `name` field is 坂本龍一 and matches nothing in the tag. The alias does.
    expect(ranked[0].name).toBe('坂本龍一')
    expect(ranked[0].nameScore).toBe(100)
  })

  it('resolves the primary artist out of a featured-artist credit', () => {
    const { verdict, ranked, query } = resolve('Daft Punk feat. Pharrell Williams', DAFT_PUNK)

    expect(query).toBe('Daft Punk')
    expect(verdict.kind).toBe('accept')
    expect(ranked[0].name).toBe('Daft Punk')
    // The guest is present and is not close. That gap is what the margin reads.
    expect(ranked[1].name).toBe('Pharrell Williams')
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(ARTIST_MATCH_MARGIN)
  })

  it('resolves across a leading article the tag omitted', () => {
    const { verdict, ranked } = resolve('Beatles', BEATLES)

    expect(verdict.kind).toBe('accept')
    expect(ranked[0].name).toBe('The Beatles')
  })

  /**
   * The artist that genuinely does not exist — and the case a live probe
   * corrected. MusicBrainz answers an unknown name with near misses rather than
   * with nothing, and every one of them has to fail the threshold: `none`, not
   * `ambiguous`, because "several artists go by this name" said over a Dave
   * Brubeck record is the confident wrong claim R5 exists to prevent.
   */
  it('reports no match for a name MusicBrainz answers with near misses', () => {
    const { verdict, ranked } = resolve('Zzyzx Tapedeck Quartet', ABSENT)

    expect(verdict).toEqual({ kind: 'none' })
    // The list is not empty, and is not discarded — a badly misspelled tag can
    // put the right artist third, which the operator can see and we cannot.
    expect(ranked).toHaveLength(3)
    expect(ranked.every((c) => c.score < ARTIST_MATCH_THRESHOLD)).toBe(true)
  })

  it('reports no match when MusicBrainz answers with nothing at all', () => {
    expect(resolve('Zzyzx Tapedeck Quartet', EMPTY)).toMatchObject({
      verdict: { kind: 'none' },
      ranked: []
    })
  })

  /**
   * Anything without a usable identifier is dropped rather than repaired. A
   * non-UUID stored on an `artists` row would look exactly like a resolved
   * artist whose biography simply never loads.
   */
  it('drops entries that could never be stored', () => {
    const ranked = rankCandidates('Perfectly Fine', parseArtistSearch(MALFORMED))

    expect(ranked.map((c) => c.name)).toEqual(['Perfectly Fine'])
  })
})

describe('the accept rule', () => {
  function candidate(score: number, name = 'x'): ScoredCandidate {
    return {
      mbid: '00000000-0000-4000-8000-000000000000',
      name,
      sortName: null,
      disambiguation: null,
      country: null,
      type: null,
      begin: null,
      end: null,
      nameScore: score,
      searchScore: score,
      score
    }
  }

  it('accepts a lone candidate above the threshold, with no runner-up to beat', () => {
    expect(decide([candidate(ARTIST_MATCH_THRESHOLD)]).kind).toBe('accept')
  })

  /** Nothing plausible at all is `none`, whatever the list length. */
  it('refuses a lone candidate below the threshold', () => {
    expect(decide([candidate(ARTIST_MATCH_THRESHOLD - 1)]).kind).toBe('none')
    expect(decide([candidate(60), candidate(20)]).kind).toBe('none')
  })

  /** Plausible but not separable is `ambiguous` — the Nirvana shape. */
  it('refuses a clear winner that is not clear enough', () => {
    const best = ARTIST_MATCH_THRESHOLD + 10
    expect(decide([candidate(best), candidate(best - ARTIST_MATCH_MARGIN + 1)]).kind).toBe(
      'ambiguous'
    )
    expect(decide([candidate(best), candidate(best - ARTIST_MATCH_MARGIN)]).kind).toBe('accept')
  })

  it('has nothing to say about an empty list', () => {
    expect(decide([])).toEqual({ kind: 'none' })
  })
})

describe('ranking', () => {
  /**
   * `decide` compares the top two, so an unstable sort would make the verdict
   * depend on the order MusicBrainz happened to serialise its array in — the
   * same artist resolving differently on two machines.
   */
  it('orders ties by name so the verdict does not depend on reply order', () => {
    const forwards = rankCandidates('Nirvana', parseArtistSearch(NIRVANA))
    const reversed = rankCandidates(
      'Nirvana',
      parseArtistSearch({
        ...NIRVANA,
        artists: [...NIRVANA.artists].reverse()
      })
    )

    expect(reversed.map((c) => c.mbid)).toEqual(forwards.map((c) => c.mbid))
  })
})
