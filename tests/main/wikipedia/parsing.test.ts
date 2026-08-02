import { describe, expect, it } from 'vitest'
import {
  extractUrl,
  parseExtract,
  toPlainText,
  wikipediaApi
} from '../../../src/main/wikipedia/extract'
import { articleLanguages, localeLanguage, wikiSite } from '../../../src/main/wikipedia/language'
import {
  entitySearchUrl,
  entitySitelinksUrl,
  isEntityId,
  parseEntitySearch,
  parseEntitySitelinks
} from '../../../src/main/wikipedia/wikidata'

/**
 * The three layers of W7-10 that are functions of a string.
 *
 * Everything here would otherwise need a fake `NetClient` to reach, and none of
 * it is about networking: what a malformed Wikidata reply does, whether a tag
 * that arrives against the contract survives to the renderer, and which
 * Wikipedia a `pt-BR` operator is sent to. Same argument as
 * `parseArtistSearch`' — the hard cases are hard at this layer.
 */

const MBID = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'

describe('article languages', () => {
  it('takes the language subtag and drops the region', () => {
    expect(localeLanguage('pt-BR')).toBe('pt')
    expect(localeLanguage('zh-Hans-CN')).toBe('zh')
    expect(localeLanguage('DE')).toBe('de')
    // Electron reports underscores on some Linux locales.
    expect(localeLanguage('fr_CA')).toBe('fr')
  })

  it('refuses anything that is not plainly a language code', () => {
    // The value is interpolated into a hostname, so this is the guard that
    // matters rather than a tidiness check.
    expect(localeLanguage('')).toBeNull()
    expect(localeLanguage('c')).toBeNull()
    expect(localeLanguage('english')).toBeNull()
    expect(localeLanguage('en.wikipedia.org')).toBeNull()
    expect(localeLanguage('../../etc')).toBeNull()
  })

  it('falls back to English without repeating it', () => {
    expect(articleLanguages('de-DE')).toEqual(['de', 'en'])
    expect(articleLanguages('en-GB')).toEqual(['en'])
    // An unparseable locale is a reason to fall back, not to show nothing.
    expect(articleLanguages('nonsense')).toEqual(['en'])
  })

  it('names sites the way Wikidata does', () => {
    expect(wikiSite('en')).toBe('enwiki')
  })
})

describe('wikidata entity search', () => {
  it('asks for an exact property match rather than a relevance search', () => {
    const url = new URL(entitySearchUrl(MBID))
    // The MBID is the identity. A free-text search here would reintroduce the
    // ambiguity R5 removed at the MusicBrainz layer.
    expect(url.searchParams.get('srsearch')).toBe(`haswbstatement:P434=${MBID}`)
    expect(url.searchParams.get('srlimit')).toBe('1')
    expect(url.host).toBe('www.wikidata.org')
  })

  it('reads the first item id out of a reply', () => {
    expect(parseEntitySearch({ query: { search: [{ title: 'Q11649' }] } })).toBe('Q11649')
  })

  it('ignores anything that is not an item id', () => {
    // A property, a lexeme or a talk page would 400 the second request.
    expect(parseEntitySearch({ query: { search: [{ title: 'P434' }, { title: 'Q42' }] } })).toBe(
      'Q42'
    )
    expect(parseEntitySearch({ query: { search: [] } })).toBeNull()
    expect(parseEntitySearch({ query: {} })).toBeNull()
    expect(parseEntitySearch(null)).toBeNull()
    expect(parseEntitySearch('<html>')).toBeNull()
  })

  it('recognises item ids and rejects near misses', () => {
    expect(isEntityId('Q1')).toBe(true)
    expect(isEntityId('Q0')).toBe(false)
    expect(isEntityId('q1')).toBe(false)
    expect(isEntityId('Q1|Q2')).toBe(false)
  })
})

describe('wikidata sitelinks', () => {
  const REPLY = {
    entities: {
      Q11649: {
        sitelinks: {
          dewiki: {
            site: 'dewiki',
            title: 'Nirvana (Band)',
            url: 'https://de.wikipedia.org/wiki/Nirvana_(Band)'
          },
          enwiki: {
            site: 'enwiki',
            title: 'Nirvana (band)',
            url: '//en.wikipedia.org/wiki/Nirvana_(band)'
          }
        }
      }
    }
  }

  it('filters the request to the languages asked for', () => {
    const url = new URL(entitySitelinksUrl('Q11649', ['de', 'en']))
    expect(url.searchParams.get('sitefilter')).toBe('dewiki|enwiki')
    expect(url.searchParams.get('props')).toBe('sitelinks/urls')
    expect(url.searchParams.get('ids')).toBe('Q11649')
  })

  it('ranks by preference rather than by the reply order', () => {
    // `wbgetentities` returns sites alphabetically, so dewiki comes first in the
    // document either way. The English-preferring operator must still get the
    // English article.
    expect(parseEntitySitelinks(REPLY, 'Q11649', ['en', 'de']).map((link) => link.lang)).toEqual([
      'en',
      'de'
    ])
    expect(parseEntitySitelinks(REPLY, 'Q11649', ['de', 'en']).map((link) => link.lang)).toEqual([
      'de',
      'en'
    ])
  })

  it('absolutises the protocol-relative URLs Wikidata serves', () => {
    // A `//host/path` href from a `file:` origin resolves to `file://host/path`.
    const [english] = parseEntitySitelinks(REPLY, 'Q11649', ['en'])
    expect(english?.url).toBe('https://en.wikipedia.org/wiki/Nirvana_(band)')
  })

  it('is empty for an item with no article in those languages', () => {
    // The common case the card names: an item created by a MusicBrainz importer
    // that no encyclopaedia has written about.
    expect(parseEntitySitelinks(REPLY, 'Q11649', ['fr'])).toEqual([])
    expect(parseEntitySitelinks({ entities: { Q11649: {} } }, 'Q11649', ['en'])).toEqual([])
    expect(parseEntitySitelinks({}, 'Q11649', ['en'])).toEqual([])
  })
})

describe('plain text', () => {
  it('asks the endpoint for text rather than HTML', () => {
    const url = new URL(extractUrl('en', 'Nirvana (band)'))
    expect(url.searchParams.get('explaintext')).toBe('1')
    expect(url.searchParams.get('exintro')).toBe('1')
    expect(url.searchParams.get('redirects')).toBe('1')
    expect(url.searchParams.get('titles')).toBe('Nirvana (band)')
    expect(url.origin).toBe('https://en.wikipedia.org')
    expect(wikipediaApi('de')).toBe('https://de.wikipedia.org/w/api.php')
  })

  it('strips markup that arrives against the contract', () => {
    // The card is absolute: no unsanitised remote HTML, under any
    // circumstances. This is the second of the three defences — the endpoint
    // parameter is the first and Vue's escaping is the third.
    expect(toPlainText('<script>alert(1)</script>Nirvana were a band.')).toBe(
      'alert(1)Nirvana were a band.'
    )
    expect(toPlainText('<b onclick="x">Bold</b> claim')).toBe('Bold claim')
    expect(toPlainText('Before<!-- a comment -->after')).toBe('Beforeafter')
  })

  it('leaves prose that merely looks like markup alone', () => {
    // A sanitiser that mangles real sentences to defend against markup the
    // endpoint does not send has made things worse, not better.
    expect(toPlainText('tempo of 4 < 5 beats')).toBe('tempo of 4 < 5 beats')
    // Decoding entities is the one thing that could reintroduce markup, so it
    // is not done: these render as visible characters.
    expect(toPlainText('&lt;script&gt;')).toBe('&lt;script&gt;')
  })

  it('keeps paragraph breaks and collapses everything else', () => {
    expect(toPlainText('One  line.\n \nTwo.\n\n\n\nThree.\r\nFour.')).toBe(
      'One line.\n\nTwo.\n\nThree.\nFour.'
    )
  })

  it('reads the extract and the title Wikipedia settled on', () => {
    const parsed = parseExtract(
      { query: { pages: [{ title: 'Nirvana (band)', extract: 'An American rock band.' }] } },
      'Nirvana'
    )
    // The reply's title, not the request's: a followed redirect must attribute
    // the article it landed on, because that string goes in a licence notice.
    expect(parsed).toEqual({ title: 'Nirvana (band)', text: 'An American rock band.' })
  })

  it('treats a missing or empty page as nothing to show', () => {
    expect(
      parseExtract({ query: { pages: [{ missing: true, title: 'Nope' }] } }, 'Nope')
    ).toBeNull()
    expect(
      parseExtract({ query: { pages: [{ title: 'Stub', extract: '   ' }] } }, 'Stub')
    ).toBeNull()
    expect(parseExtract({ query: { pages: [] } }, 'Nope')).toBeNull()
    expect(parseExtract(null, 'Nope')).toBeNull()
  })
})
