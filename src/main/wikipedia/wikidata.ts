/**
 * The first hop: a MusicBrainz identifier to a Wikipedia article title.
 *
 * ## Why two requests and not one
 *
 * Wikidata's query service would do this in one SPARQL statement, and that is
 * the obvious answer until you look at what it costs. WDQS is a shared analytic
 * endpoint with a sixty-second query timeout, aggressive throttling and a
 * history of returning 429 to well-behaved clients during backlog; it is built
 * for research queries rather than for a lookup a music player makes every time
 * a track changes. The two calls here both hit `www.wikidata.org/w/api.php`,
 * which is the ordinary MediaWiki API — same host, so the limiter treats them as
 * one queue, and both are cheap enough to be uninteresting to Wikimedia.
 *
 * They are also cached as a *pair*: the service stores what came out of
 * `resolveEntity`, so the steady state after the first lookup is zero requests
 * rather than one. Splitting the cache per hop would have saved nothing, because
 * nothing else in Oscine asks either question on its own.
 *
 * ## Why `haswbstatement` rather than a search
 *
 * `haswbstatement:P434=<mbid>` is an exact-match filter on a property value, not
 * a relevance search — it either finds the item carrying that MusicBrainz ID or
 * finds nothing. That matters more than it sounds: a free-text search for an
 * artist name would reintroduce, at the Wikidata layer, exactly the ambiguity
 * R5 spent the whole of W7-9 removing at the MusicBrainz layer. The MBID is the
 * identity; this hop must not be allowed to second-guess it.
 *
 * Everything is parsed defensively, for `musicbrainz/search.ts`' reason.
 */

import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { wikiSite } from './language'

/** The MediaWiki API root for Wikidata. Not the query service; see above. */
export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'

/** Wikidata's "MusicBrainz artist ID" property. The join between the two worlds. */
export const MUSICBRAINZ_ARTIST_PROPERTY = 'P434'

/** Wikidata's "image" property. A Commons file name, not a URL. */
export const IMAGE_PROPERTY = 'P18'

/** One language's article, as Wikidata knows about it. */
export interface Sitelink {
  /** The language subtag, recovered from the site id — `enwiki` gives `en`. */
  lang: string
  title: string
  /** Wikidata's own canonical URL for the article. Not built by us. */
  url: string
}

/**
 * What the first hop yields.
 *
 * An empty `sitelinks` is a real and common answer: the artist has a Wikidata
 * item — often created by a MusicBrainz importer — and no encyclopaedia article
 * in either of the languages we asked about. It is cached positively rather than
 * negatively, because the *item* exists, and the fact that it carries no article
 * today is a fact about the item.
 */
export interface WikidataEntity {
  entityId: string
  sitelinks: Sitelink[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Wikidata item ids are `Q` followed by digits.
 *
 * Checked rather than trusted because the value is interpolated into the second
 * request's query string, and because a search result whose title is not an item
 * id means we were handed a page from some other namespace — a property, a
 * lexeme, a talk page — which `wbgetentities` would then reject with a 400.
 */
export function isEntityId(value: string): boolean {
  return /^Q[1-9][0-9]*$/.test(value)
}

export function entitySearchUrl(mbid: string): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    list: 'search',
    srsearch: `haswbstatement:${MUSICBRAINZ_ARTIST_PROPERTY}=${mbid}`,
    // One, because the property is single-valued in practice and a second hit
    // would be a Wikidata data problem we have no way to adjudicate.
    srlimit: '1',
    srnamespace: '0'
  })
  return `${WIKIDATA_API}?${params.toString()}`
}

/** Pulls the first item id out of a search reply. `null` when there is none. */
export function parseEntitySearch(body: unknown): string | null {
  const results = asRecord(asRecord(body)?.query)?.search
  if (!Array.isArray(results)) return null

  for (const entry of results) {
    const title = asString(asRecord(entry)?.title)
    if (title && isEntityId(title)) return title
  }
  return null
}

export function entitySitelinksUrl(entityId: string, languages: readonly string[]): string {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    format: 'json',
    formatversion: '2',
    ids: entityId,
    // `sitelinks/urls` rather than `sitelinks`: the canonical article URL comes
    // back with the title, which saves us encoding one ourselves. Titles contain
    // spaces, slashes and parentheses — "Nirvana (band)", "AC/DC" — and a
    // hand-built URL gets one of those wrong eventually.
    props: 'sitelinks/urls',
    // Filtered, because an unfiltered reply for a well-known band is three
    // hundred wikis and a quarter of a megabyte for two lines we will use.
    sitefilter: languages.map(wikiSite).join('|')
  })
  return `${WIKIDATA_API}?${params.toString()}`
}

/**
 * Reads the sitelinks for one item, in the order the languages were asked for.
 *
 * The order is ours rather than the reply's. `wbgetentities` returns a
 * site-keyed object whose iteration order is alphabetical by site id, which
 * would put `dewiki` ahead of `enwiki` regardless of which the operator can
 * read. Ranking here is what makes `articleLanguages` a preference rather than a
 * set.
 */
export function parseEntitySitelinks(
  body: unknown,
  entityId: string,
  languages: readonly string[]
): Sitelink[] {
  const entity = asRecord(asRecord(asRecord(body)?.entities)?.[entityId])
  const sitelinks = asRecord(entity?.sitelinks)
  if (!sitelinks) return []

  const found: Sitelink[] = []
  for (const lang of languages) {
    const link = asRecord(sitelinks[wikiSite(lang)])
    if (!link) continue

    const title = asString(link.title)
    const url = asString(link.url)
    if (!title || !url) continue

    // Wikidata serves protocol-relative sitelink URLs (`//en.wikipedia.org/…`),
    // which is fine in a browser and useless in an anchor rendered from a
    // `file:` origin — it would resolve to `file://en.wikipedia.org`. Fixed
    // here, where the shape is known, rather than in the pane.
    found.push({ lang, title, url: url.startsWith('//') ? `https:${url}` : url })
  }
  return found
}

/**
 * Both hops, as one operation.
 *
 * A search that finds no item is `not-found` rather than an empty success, for
 * `searchArtists`' reason: that is what routes it into the negative cache, and
 * an artist with no Wikidata item must cost one request a week rather than one
 * per play. An item that exists with no article is *not* `not-found` — it is a
 * successful answer that happens to be empty, and the distinction is what stops
 * the second hop being attempted for it.
 */
export async function resolveEntity(
  client: NetClient,
  mbid: string,
  languages: readonly string[]
): Promise<NetResult<WikidataEntity>> {
  const search = await client.getJson<unknown>({
    url: entitySearchUrl(mbid),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!search.ok) return search

  const entityId = parseEntitySearch(search.value)
  if (entityId === null) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }

  const entity = await client.getJson<unknown>({
    url: entitySitelinksUrl(entityId, languages),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!entity.ok) return entity

  return netOk({ entityId, sitelinks: parseEntitySitelinks(entity.value, entityId, languages) })
}

/**
 * The P18 claim for one item.
 *
 * `wbgetclaims` rather than widening `entitySitelinksUrl`'s `props`, and the
 * reason is the cache rather than the wire. `wikidata.entity` holds a document
 * whose shape is `{ entityId, sitelinks }` and whose rows live for a fortnight;
 * adding a field to it would mean every row written before this card parses
 * back with the field missing, which is indistinguishable from "this artist has
 * no photograph". A separate request under a separate entity has no such
 * fortnight of silent wrong answers, and it is only made when the deck actually
 * wants a picture.
 *
 * The item id is already known by then — the biography's first hop resolved it
 * and cached it — so this costs one request rather than two.
 */
export function entityImageUrl(entityId: string): string {
  const params = new URLSearchParams({
    action: 'wbgetclaims',
    format: 'json',
    formatversion: '2',
    entity: entityId,
    property: IMAGE_PROPERTY
  })
  return `${WIKIDATA_API}?${params.toString()}`
}

/**
 * The Commons file name from a claims reply. `null` when there is no image.
 *
 * The first claim with a normal rank and a string value. Wikidata permits
 * several P18s — a band with a photograph per era, an artist with a portrait
 * and a signature — and offers no ordering beyond rank, so "the first one" is
 * as principled as this gets. Deprecated claims are skipped because that is
 * what the rank means: somebody looked at it and said it was wrong.
 */
export function parseEntityImage(body: unknown): string | null {
  const claims = asRecord(asRecord(body)?.claims)?.[IMAGE_PROPERTY]
  if (!Array.isArray(claims)) return null

  for (const claim of claims) {
    const record = asRecord(claim)
    if (asString(record?.rank) === 'deprecated') continue
    const snak = asRecord(record?.mainsnak)
    // `novalue` and `somevalue` snaks carry no datavalue at all — "known to
    // have no image" and "has one we cannot name". Both are no picture.
    if (asString(snak?.snaktype) !== 'value') continue
    const file = asString(asRecord(snak?.datavalue)?.value)
    if (file) return file
  }
  return null
}

/**
 * The artist's photograph, as a Commons file name.
 *
 * `not-found` rather than an empty success when the item carries no P18, unlike
 * `resolveEntity`'s empty sitelinks. The two look similar and are not: an item
 * with no article is still an answer about the article we asked for, whereas
 * this is the whole of what was asked. Routing it to the negative cache is what
 * makes an artist with no photograph — most of a library — cost one request a
 * week instead of one per play.
 */
export async function fetchEntityImage(
  client: NetClient,
  entityId: string
): Promise<NetResult<string>> {
  const claims = await client.getJson<unknown>({
    url: entityImageUrl(entityId),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!claims.ok) return claims

  const file = parseEntityImage(claims.value)
  if (file === null) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }
  return netOk(file)
}
