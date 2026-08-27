import { describe, expect, it } from 'vitest'
import {
  ARTIST_TAGS_INC,
  artistTagsCacheKey,
  artistTagsUrl,
  parseArtistTags
} from '../../../src/main/musicbrainz/artistTags'

/**
 * The parse, which is the whole of this file worth testing without a socket: the
 * genre/tag merge, the shared casefold dedup, the weight order, and the votes it
 * refuses to offer.
 */

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'

describe('parseArtistTags', () => {
  it('merges genres and tags into one list keyed on the shared casefold', () => {
    // "Rock" is both a curated genre and a folksonomy tag — the ordinary case,
    // and the one a naive concat would draw twice.
    const parsed = parseArtistTags({
      genres: [
        { name: 'Rock', count: 5 },
        { name: 'grunge', count: 3 }
      ],
      tags: [
        { name: 'rock', count: 2 },
        { name: 'seattle', count: 4 }
      ]
    })

    expect(parsed.map((tag) => tag.label)).toEqual(['Rock', 'seattle', 'grunge'])
  })

  it('keeps the larger weight and the genre spelling when a label appears in both', () => {
    const parsed = parseArtistTags({
      genres: [{ name: 'Rock', count: 5 }],
      tags: [{ name: 'ROCK', count: 9 }]
    })

    expect(parsed).toHaveLength(1)
    // The genre was seen first, so its spelling wins; the tag's weight is larger,
    // so that is the one kept.
    expect(parsed[0]).toMatchObject({ label: 'Rock', count: 9 })
  })

  it('orders by weight descending, then by label so the order is stable', () => {
    const parsed = parseArtistTags({
      tags: [
        { name: 'zeta', count: 4 },
        { name: 'alpha', count: 4 },
        { name: 'high', count: 10 }
      ]
    })

    expect(parsed.map((tag) => tag.label)).toEqual(['high', 'alpha', 'zeta'])
  })

  it('drops a tag the crowd voted to zero or below', () => {
    // MusicBrainz's count is the net of up and down votes. A contested or
    // downvoted tag is not a label to offer as one to adopt.
    const parsed = parseArtistTags({
      tags: [
        { name: 'kept', count: 1 },
        { name: 'contested', count: 0 },
        { name: 'hated', count: -3 }
      ]
    })

    expect(parsed.map((tag) => tag.label)).toEqual(['kept'])
  })

  it('survives malformed entries, missing arrays and a non-object body', () => {
    expect(parseArtistTags(null)).toEqual([])
    expect(parseArtistTags('nope')).toEqual([])
    expect(parseArtistTags({})).toEqual([])
    expect(
      parseArtistTags({
        genres: 'not-an-array',
        tags: [null, 42, { name: '   ' }, { name: 'good', count: 2 }, { count: 3 }]
      })
    ).toEqual([{ key: 'good', label: 'good', count: 2 }])
  })

  it('treats a missing count as no votes and drops it', () => {
    expect(parseArtistTags({ tags: [{ name: 'uncounted' }] })).toEqual([])
  })
})

describe('the lookup address', () => {
  it('asks the artist endpoint for genres and tags as json', () => {
    expect(artistTagsUrl(MBID)).toBe(
      `https://musicbrainz.org/ws/2/artist/${MBID}?inc=${ARTIST_TAGS_INC}&fmt=json`
    )
  })

  it('names the inc in the cache key so a relations reply cannot answer it', () => {
    expect(artistTagsCacheKey(MBID)).toBe(`${MBID}/${ARTIST_TAGS_INC}`)
  })
})
