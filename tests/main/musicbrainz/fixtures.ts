/**
 * R5's fixture set: chosen to be hard, not easy.
 *
 * The card is explicit that the threshold has to be tuned "against the whole
 * fixture set rather than against whichever artist happened to be playing during
 * development", so these are the five cases the risk itself names — an ambiguous
 * name, one with punctuation, one non-Latin, one carrying a featured-artist
 * string, and one that genuinely does not exist — plus the leading-article case
 * R5 lists alongside them.
 *
 * They are hand-authored rather than recorded, and trimmed to the fields
 * `parseArtistSearch` reads. A recorded capture would carry a few hundred
 * kilobytes of tags, areas and relation stubs whose only effect on this test
 * suite is to make a diff unreadable; what is load-bearing here is the *shape*
 * of the disagreement between the tag and the service, and that fits in a
 * literal. The scores are MusicBrainz's own, in the ranges its search actually
 * returns: 100 for an exact name or alias hit, high eighties to nineties for a
 * strong partial, and lower for a term match.
 */

/** A MusicBrainz artist search document, as the web service returns it. */
export interface SearchDocument {
  created: string
  count: number
  offset: number
  artists: unknown[]
}

function document(artists: unknown[]): SearchDocument {
  return { created: '2026-08-02T00:00:00.000Z', count: artists.length, offset: 0, artists }
}

/**
 * The worked example, and the reason a threshold alone is not the mitigation.
 *
 * Every one of these is called exactly "Nirvana" and every one is an exact
 * match. No scoring rule can pick the right one, which is why the correct
 * outcome is `ambiguous` and a picker rather than a confident answer.
 */
export const NIRVANA = document([
  {
    id: '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6',
    name: 'Nirvana',
    'sort-name': 'Nirvana',
    type: 'Group',
    country: 'US',
    disambiguation: '1980s–1990s US grunge band',
    'life-span': { begin: '1987-12', end: '1994-04-05', ended: true },
    score: 100
  },
  {
    id: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
    name: 'Nirvana',
    'sort-name': 'Nirvana',
    type: 'Group',
    country: 'GB',
    disambiguation: '60s band from the UK',
    'life-span': { begin: '1965', end: null, ended: false },
    score: 96
  },
  {
    id: 'ac865b2e-bba8-4f5a-8756-dd40d5a39187',
    name: 'Nirvana',
    'sort-name': 'Nirvana',
    type: 'Person',
    country: null,
    disambiguation: 'Slovenian singer',
    'life-span': { begin: null, end: null, ended: false },
    score: 93
  }
])

/**
 * Punctuation. The tag has been flattened by whoever wrote it and MusicBrainz
 * has not, which is the ordinary case rather than the exotic one.
 */
export const GODSPEED = document([
  {
    id: '3648ee1b-8d0f-4b7c-b3d1-3e5e1eb1b3b1',
    name: 'Godspeed You! Black Emperor',
    'sort-name': 'Godspeed You! Black Emperor',
    type: 'Group',
    country: 'CA',
    disambiguation: null,
    'life-span': { begin: '1994', end: null, ended: false },
    score: 100
  },
  {
    id: '7c1014eb-454c-4867-b3ab-3d0d4ba0f0a1',
    name: 'Godspeed',
    'sort-name': 'Godspeed',
    type: 'Group',
    country: 'US',
    disambiguation: 'US hardcore band',
    'life-span': { begin: '1993', end: '1997', ended: true },
    score: 85
  }
])

/**
 * Non-Latin, resolved through an alias.
 *
 * MusicBrainz stores this artist under the Japanese name and carries the
 * transliteration as an alias and as the sort name. A library tagged the Western
 * way matches neither the `name` field nor a naive comparison of it — the alias
 * and the comma-inverted sort name are what make it work, which is why the
 * search asks for aliases at all.
 */
export const SAKAMOTO = document([
  {
    id: 'e0e1ce9c-2ec9-4d0c-9d3d-1a5b0d3a0f2b',
    name: '坂本龍一',
    'sort-name': 'Sakamoto, Ryuichi',
    type: 'Person',
    country: 'JP',
    disambiguation: 'Japanese composer, pianist and producer',
    'life-span': { begin: '1952-01-17', end: '2023-03-28', ended: true },
    aliases: [
      { name: 'Ryuichi Sakamoto', 'sort-name': 'Sakamoto, Ryuichi' },
      { name: 'Ryûichi Sakamoto', 'sort-name': 'Sakamoto, Ryûichi' }
    ],
    score: 100
  },
  {
    id: 'd1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    name: 'Yellow Magic Orchestra',
    'sort-name': 'Yellow Magic Orchestra',
    type: 'Group',
    country: 'JP',
    disambiguation: null,
    'life-span': { begin: '1978', end: '2023', ended: true },
    score: 62
  }
])

/**
 * A featured-artist credit. The whole tag searched verbatim finds neither
 * artist well; the head of it finds one exactly, and the guest turns up as a
 * distant runner-up, which is what the margin is measured against.
 */
export const DAFT_PUNK = document([
  {
    id: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
    name: 'Daft Punk',
    'sort-name': 'Daft Punk',
    type: 'Group',
    country: 'FR',
    disambiguation: null,
    'life-span': { begin: '1993', end: '2021-02-22', ended: true },
    score: 100
  },
  {
    id: 'a9c4d2c1-8f0d-4b74-9d0a-9e1b7c2f3a4e',
    name: 'Pharrell Williams',
    'sort-name': 'Williams, Pharrell',
    type: 'Person',
    country: 'US',
    disambiguation: null,
    'life-span': { begin: '1973-04-05', end: null, ended: false },
    score: 78
  }
])

/**
 * A leading article, which R5 lists among the four things that break naive
 * lookup. The tag omits it and MusicBrainz carries it; the sort name inverted at
 * its comma is what closes the gap.
 */
export const BEATLES = document([
  {
    id: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d',
    name: 'The Beatles',
    'sort-name': 'Beatles, The',
    type: 'Group',
    country: 'GB',
    disambiguation: null,
    'life-span': { begin: '1957-03', end: '1970-04-10', ended: true },
    score: 100
  },
  {
    id: 'c4b1f5d6-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    name: 'The Beatles Recovered Band',
    'sort-name': 'Beatles Recovered Band, The',
    type: 'Group',
    country: 'GB',
    disambiguation: 'tribute act',
    'life-span': { begin: null, end: null, ended: false },
    score: 71
  }
])

/**
 * The artist that genuinely is not there, as MusicBrainz actually answers.
 *
 * Recorded from a live probe for "Zzyzx Tapedeck Quartet", and it is the reason
 * this fixture exists in two shapes. The search is fuzzy: a name nobody has
 * comes back not as an empty array but as whatever shares a word with it,
 * scoring in the sixties. Anything that folded this into "several artists go by
 * this name" would put R5's confident wrong claim in the header instead of in
 * the biography.
 */
export const ABSENT = document([
  {
    id: '0a4d4a2b-1e5f-4c9d-8a3b-2c1d0e9f8a7b',
    name: 'Tapedeck Quincy',
    'sort-name': 'Tapedeck Quincy',
    type: 'Person',
    country: null,
    disambiguation: null,
    'life-span': { begin: null, end: null, ended: false },
    score: 82
  },
  {
    id: '1b5e5b3c-2f6a-4d0e-9b4c-3d2e1f0a9b8c',
    name: 'Tapedeck',
    'sort-name': 'Tapedeck',
    type: 'Group',
    country: 'DE',
    disambiguation: null,
    'life-span': { begin: null, end: null, ended: false },
    score: 80
  },
  {
    id: '2c6f6c4d-3a7b-4e1f-8c5d-4e3f2a1b0c9d',
    name: 'The Dave Brubeck Quartet',
    'sort-name': 'Brubeck, Dave, Quartet',
    type: 'Group',
    country: 'US',
    disambiguation: null,
    'life-span': { begin: '1951', end: '1967', ended: true },
    score: 78
  }
])

/** The rarer shape: MusicBrainz with genuinely nothing to say. */
export const EMPTY = document([])

/**
 * A reply carrying entries this build must refuse to store: no identifier, an
 * identifier that is not a UUID, and no name. None of them can end up on an
 * `artists` row, so none of them may reach the scorer.
 */
export const MALFORMED = document([
  { name: 'No Identifier', 'sort-name': 'No Identifier', score: 100 },
  { id: 'not-a-uuid', name: 'Bad Identifier', score: 100 },
  { id: 'f0e1d2c3-b4a5-4968-8778-6a5b4c3d2e1f', 'sort-name': 'No Name', score: 100 },
  {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Perfectly Fine',
    'sort-name': 'Perfectly Fine',
    score: 90
  }
])
