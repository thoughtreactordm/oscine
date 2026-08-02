import { describe, expect, it } from 'vitest'
import {
  compareKey,
  escapeLucene,
  searchCacheKey,
  searchQuery
} from '../../../src/main/musicbrainz/artistName'

/**
 * Three of R5's four named breakages are string problems, and this is where
 * they are solved. The fourth — an ambiguous name — is `resolution.test.ts`.
 */

describe('searchQuery', () => {
  it('drops a bare featured-artist trailer', () => {
    expect(searchQuery('Daft Punk feat. Pharrell Williams')).toBe('Daft Punk')
    expect(searchQuery('Daft Punk ft Pharrell Williams')).toBe('Daft Punk')
    expect(searchQuery('Daft Punk featuring Pharrell Williams')).toBe('Daft Punk')
  })

  it('drops a bracketed one, in any bracket', () => {
    expect(searchQuery('Daft Punk (feat. Pharrell Williams)')).toBe('Daft Punk')
    expect(searchQuery('Daft Punk [ft. Pharrell]')).toBe('Daft Punk')
    expect(searchQuery('Daft Punk (with Pharrell Williams)')).toBe('Daft Punk')
  })

  /**
   * The rule that protects real names. A conjunction is not a credit marker, and
   * a splitter that did not know the difference would search for "Simon".
   */
  it('leaves conjunctions and bare "with" alone', () => {
    expect(searchQuery('Simon & Garfunkel')).toBe('Simon & Garfunkel')
    expect(searchQuery('Nick Cave & The Bad Seeds')).toBe('Nick Cave & The Bad Seeds')
    expect(searchQuery('Sleaford Mods vs. Pet Shop Boys')).toBe('Sleaford Mods vs. Pet Shop Boys')
    expect(searchQuery('The Kills with Alison Mosshart')).toBe('The Kills with Alison Mosshart')
  })

  it('keeps something to search for when the tag is only a credit', () => {
    expect(searchQuery('feat. Pharrell Williams')).toBe('feat. Pharrell Williams')
  })

  it('collapses whitespace', () => {
    expect(searchQuery('  Daft   Punk  ')).toBe('Daft Punk')
  })
})

describe('escapeLucene', () => {
  /**
   * The punctuation case at the transport layer rather than the scoring layer.
   * Unescaped, this is a query syntax error and comes back as a 400 — which the
   * deck would report as `rejected`, meaning "a bug on our side". It would be
   * right.
   */
  it('escapes the characters MusicBrainz parses as syntax', () => {
    expect(escapeLucene('Sunn O)))')).toBe('Sunn O\\)\\)\\)')
    expect(escapeLucene('AC/DC')).toBe('AC\\/DC')
    expect(escapeLucene('!!!')).toBe('\\!\\!\\!')
    expect(escapeLucene('Simon & Garfunkel')).toBe('Simon \\& Garfunkel')
  })

  it('leaves an ordinary name untouched', () => {
    expect(escapeLucene('Daft Punk')).toBe('Daft Punk')
    expect(escapeLucene('坂本龍一')).toBe('坂本龍一')
  })
})

describe('compareKey', () => {
  it('folds case, punctuation and spacing together', () => {
    expect(compareKey('Godspeed You! Black Emperor')).toBe(compareKey('godspeed you black emperor'))
    expect(compareKey('AC/DC')).toBe(compareKey('AC DC'))
    expect(compareKey("Guns N' Roses")).toBe(compareKey('Guns N Roses'))
  })

  it('folds diacritics', () => {
    expect(compareKey('Björk')).toBe(compareKey('Bjork'))
    expect(compareKey('Sigur Rós')).toBe(compareKey('Sigur Ros'))
  })

  /**
   * Non-Latin scripts must survive rather than be normalised into nothing. Every
   * step except the article drop is either a no-op here or a decomposition
   * applied identically to both sides.
   */
  it('leaves non-Latin names comparable', () => {
    expect(compareKey('坂本龍一')).toBe('坂本龍一')
    expect(compareKey('한대수')).toBe(compareKey('한대수'))
    expect(compareKey('Мумий Тролль')).toBe(compareKey('Мумий Тролль'))
    // Still discriminating, which is the half that would be easy to lose: a
    // normalisation aggressive enough to fold every script into the same key
    // would "match" everything.
    expect(compareKey('坂本龍一')).not.toBe(compareKey('久石譲'))
    expect(compareKey('Мумий Тролль')).not.toBe(compareKey('Кино'))
  })

  /**
   * The diacritic fold is not a Latin-only rule, and it should not be. Cyrillic
   * й decomposes to и plus a breve, so it folds exactly as é folds to e — a
   * transliteration difference in the tag, forgiven on both sides of the
   * comparison. Written down because the behaviour surprises on first reading.
   */
  it('folds a combining mark off a Cyrillic letter, like any other', () => {
    expect(compareKey('Мумий Тролль')).toBe('мумии тролль')
  })

  it('drops a leading English article, and only a leading one', () => {
    expect(compareKey('The Beatles')).toBe('beatles')
    expect(compareKey('Beatles')).toBe('beatles')
    expect(compareKey('Los Lobos')).toBe('los lobos')
    expect(compareKey('Take That')).toBe('take that')
  })

  it('keeps a name that is nothing but an article', () => {
    expect(compareKey('The The')).toBe('the')
    expect(compareKey('The')).toBe('the')
  })

  /**
   * `toLowerCase` and not `toLocaleLowerCase`: on a Turkish host the latter
   * folds "I" to a dotless ı and this stops matching.
   */
  it('casefolds independently of the host locale', () => {
    expect(compareKey('INXS')).toBe('inxs')
  })
})

describe('searchCacheKey', () => {
  it('folds case and whitespace, so re-tagged capitalisation is one entry', () => {
    expect(searchCacheKey('Daft Punk')).toBe(searchCacheKey('daft  punk '))
  })

  /**
   * And deliberately does *not* fold diacritics. A cache key claims the stored
   * reply is the reply this request would get, and answering "Björk" from a
   * search that only ever sent "bjork" is a claim we cannot make.
   */
  it('does not fold diacritics', () => {
    expect(searchCacheKey('Björk')).not.toBe(searchCacheKey('Bjork'))
  })
})
