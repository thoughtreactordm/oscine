import { describe, expect, it } from 'vitest'
import { splitGenres } from '../../../src/shared/genre'

/**
 * The splitter is the whole of migration 013's semantics: everything downstream
 * — the backfill, the scanner's rewrite, a future alias map — is plumbing around
 * this function. So the rules are asserted here as a table, and the tables that
 * store its output are tested for their plumbing rather than for these rules.
 */
describe('splitGenres', () => {
  const cases: [string, string | null, { key: string; genre: string }[]][] = [
    ['leaves a single genre alone', 'Rock', [{ key: 'rock', genre: 'Rock' }]],
    [
      'splits on a semicolon',
      'Rock; Alternative',
      [
        { key: 'rock', genre: 'Rock' },
        { key: 'alternative', genre: 'Alternative' }
      ]
    ],
    [
      'splits on a comma',
      'Ambient,Downtempo',
      [
        { key: 'ambient', genre: 'Ambient' },
        { key: 'downtempo', genre: 'Downtempo' }
      ]
    ],
    // The accepted cost, asserted rather than lamented: this is what `/` does,
    // and a change here is a change to every operator's genre counts.
    [
      'splits on a slash, which is the accepted cost',
      'Hip-Hop/Rap',
      [
        { key: 'hip-hop', genre: 'Hip-Hop' },
        { key: 'rap', genre: 'Rap' }
      ]
    ],
    // The other half of that trade: an ampersand is not a separator, so the
    // genres that survive `/` are the ones spelled with `&`.
    ['keeps an ampersand intact', 'R&B', [{ key: 'r&b', genre: 'R&B' }]],
    ['trims surrounding whitespace', '  rock  ', [{ key: 'rock', genre: 'rock' }]],
    [
      'collapses internal whitespace',
      'Drum   and\tBass',
      [{ key: 'drum and bass', genre: 'Drum and Bass' }]
    ],
    [
      'casefolds the key but keeps the spelling',
      'PROGRESSIVE',
      [{ key: 'progressive', genre: 'PROGRESSIVE' }]
    ],
    [
      'keeps the first spelling of a repeated key',
      'Rock; rock; ROCK',
      [{ key: 'rock', genre: 'Rock' }]
    ],
    [
      'drops empty segments between separators',
      'Jazz;;/,Funk',
      [
        { key: 'jazz', genre: 'Jazz' },
        { key: 'funk', genre: 'Funk' }
      ]
    ],
    ['yields nothing for a tag that is only separators', ';/,', []],
    ['yields nothing for whitespace', '   ', []],
    ['yields nothing for an empty string', '', []],
    ['yields nothing for null', null, []]
  ]

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(splitGenres(input)).toEqual(expected)
    })
  }

  it('yields nothing for undefined', () => {
    expect(splitGenres(undefined)).toEqual([])
  })

  it('preserves the order the genres appear in', () => {
    expect(splitGenres('Zydeco; Ambient; Metal').map((g) => g.key)).toEqual([
      'zydeco',
      'ambient',
      'metal'
    ])
  })

  it('is locale-independent, so the key does not depend on who opened the file', () => {
    // `toLocaleLowerCase` under a Turkish locale folds `I` to a dotless `ı`,
    // which would give the same library two different keys for `INDIE`
    // depending on the machine. The key is persisted; it has to be stable.
    expect(splitGenres('INDIE')[0].key).toBe('indie')
  })
})
