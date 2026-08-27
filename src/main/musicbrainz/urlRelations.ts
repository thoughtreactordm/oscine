/**
 * The MusicBrainz artist document, read for its outbound URLs.
 *
 * The sibling of `relations.ts`: one request against
 * `/artist/{mbid}?inc=url-rels`, a *lookup* and not a search, against an identity
 * R5 already settled — nothing here second-guesses who the artist is. Where
 * `relations.ts` reads the `artist-rels` half of the document, this reads the
 * `url-rels` half; they are two `inc`s against one endpoint, kept as two cached
 * documents so the outbound-links pane and the members pane do not each pay for
 * the other's payload on every track change. See `urlRelationsCacheKey`.
 *
 * Parsed defensively, for `search.ts`' reason and one more: every URL that
 * survives here is handed to `shell.openExternal` in the renderer, so a
 * `javascript:` or `file:` resource that slipped through would be an
 * open-anything primitive rather than a bad row. The scheme is checked here as
 * well as at the `app.openExternal` boundary — belt and braces, because the two
 * checks guard different failures.
 */

import type { ArtistLink, ArtistLinkCategory } from '@shared/artistLinks'
import { isMbid } from '@shared/artist'
import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { MUSICBRAINZ_WS } from './search'

/**
 * What the lookup asks for, and the half of the cache key that is not the MBID.
 *
 * `url-rels` alone, for the mirror of the reason `ARTIST_RELATIONS_INC` is
 * `artist-rels` alone: the same endpoint answers both, and asking for both here
 * would make each pane pay for the other's payload. Naming the `inc` in the cache
 * key is what keeps the two documents from colliding — see `urlRelationsCacheKey`.
 */
export const ARTIST_URL_RELATIONS_INC = 'url-rels'

/**
 * MusicBrainz's URL relationship types, mapped onto the four the pane draws.
 *
 * Closed and deliberately short, `relations.ts`' `KIND_BY_TYPE` rule: a type
 * absent from here is dropped rather than bucketed, because the URLs this table
 * leaves out — `discogs`, `wikidata`, `allmusic`, `IMDb`, `VIAF`, `BBC Music`,
 * `songkick`, `setlistfm`, lyrics sites — are catalogue cross-references rather
 * than places a listener goes next, and a pane listing them would spend the
 * operator's attention on authority control.
 *
 * `social network` is MusicBrainz's umbrella for the socials the card names —
 * it covers Twitter/X, Instagram, Facebook, Mastodon, TikTok and the rest, so
 * one entry buys them all without a per-service table that would go stale.
 * `streaming` and `free streaming` are left out on purpose: the card scopes this
 * to homepage, Bandcamp, purchase and socials, and a format-first player that is
 * pointedly not a streaming client has no reason to grow a Spotify button.
 */
const CATEGORY_BY_TYPE: Readonly<Record<string, ArtistLinkCategory>> = {
  'official homepage': 'homepage',
  bandcamp: 'bandcamp',
  'purchase for download': 'purchase',
  'purchase for mail order': 'purchase',
  'social network': 'social'
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
 * Which of the four a URL relationship type is, or `null` for one the pane does
 * not draw.
 *
 * Exported for the reason `relationKind` is: the mapping is the part of this file
 * worth testing on its own, and a test that had to build a whole MusicBrainz
 * document to assert that `official homepage` lands under `homepage` would be a
 * test about JSON rather than about the table.
 */
export function linkCategory(type: string): ArtistLinkCategory | null {
  return CATEGORY_BY_TYPE[type.toLowerCase()] ?? null
}

/**
 * An absolute http/https URL, or `null`.
 *
 * The gate every outbound URL passes before the renderer sees it. `shell`
 * launches `file:`, `mailto:` and worse; MusicBrainz is edited by the public and
 * a resource does occasionally arrive malformed or with a hostile scheme, so the
 * scheme is fixed here as well as at `app.openExternal`. Normalised through `URL`
 * so the dedupe downstream compares canonical strings rather than the raw text
 * two editors happened to type.
 */
function safeUrl(value: unknown): string | null {
  const raw = asString(value)
  if (raw === null) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.toString()
}

/**
 * The order the categories are drawn in, and therefore the order truncation keeps.
 *
 * Homepage first because it is the artist's own front door and the one link that
 * is theirs rather than a platform's; Bandcamp next because it is the storefront
 * the card singles out and a format-first listener's most likely purchase; the
 * other purchase links after it; socials last, being both the most numerous and
 * the least likely to be what the pane was opened for.
 */
const CATEGORY_ORDER: Readonly<Record<ArtistLinkCategory, number>> = {
  homepage: 0,
  bandcamp: 1,
  purchase: 2,
  social: 3
}

/**
 * Reads the `relations` array out of an artist document and keeps the outbound
 * URLs among them.
 *
 * Exported for `parseArtistRelations`' reason: the awkward cases — a relation
 * with no `url` object, a resource with a hostile scheme, the same link recorded
 * twice under two types — are awkward at this layer, and asserting on them
 * through a fake `NetClient` would be a test about plumbing.
 *
 * Deduped by URL, and the first category wins: MusicBrainz occasionally files one
 * address under two relationship types (a Bandcamp page that is also tagged as
 * the official homepage), and drawing it twice under two headings reads as a bug.
 * Sorting by `CATEGORY_ORDER` before the dedupe would decide which heading it
 * keeps; sorting after keeps the parse cheap and lets the caller order once.
 */
export function parseArtistUrlRelations(body: unknown): ArtistLink[] {
  const document = asRecord(body)
  const raw = document?.relations
  if (!Array.isArray(raw)) return []

  const byUrl = new Map<string, ArtistLink>()
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue

    // The document carries relations to every entity type MusicBrainz links an
    // artist to. This pane is about URLs, and a `target-type` check is cheaper
    // and more honest than inferring it from which sub-object is present.
    if (asString(record['target-type']) !== 'url') continue

    const type = asString(record.type)
    if (!type) continue

    const category = linkCategory(type)
    if (category === null) continue

    const target = asRecord(record.url)
    const url = safeUrl(target?.resource)
    if (url === null) continue

    if (!byUrl.has(url)) byUrl.set(url, { category, url })
  }

  const links = [...byUrl.values()]
  links.sort(
    (a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || a.url.localeCompare(b.url)
  )
  return links
}

/**
 * The lookup URL for one artist's outbound links.
 *
 * `fmt=json` for `artistRelationsUrl`'s reason, and the identifier interpolated
 * rather than sent as a query parameter because that is the endpoint's shape; it
 * is checked before it gets here, which is what makes that safe.
 */
export function artistUrlRelationsUrl(mbid: string): string {
  return `${MUSICBRAINZ_WS}/artist/${encodeURIComponent(mbid)}?inc=${ARTIST_URL_RELATIONS_INC}&fmt=json`
}

/**
 * The cache key for the outbound-links half of an artist document.
 *
 * The `inc` is in the key and is not decoration: `relationsCacheKey` stores the
 * `artist-rels` document under `${mbid}/artist-rels`, and a bare-MBID key here
 * would let one of the two answer a request that asked for the other — a links
 * pane served a members document, silently, missing exactly the half it wanted.
 */
export function urlRelationsCacheKey(mbid: string): string {
  return `${mbid}/${ARTIST_URL_RELATIONS_INC}`
}

/**
 * Fetches one artist's outbound links.
 *
 * An artist MusicBrainz records no URLs for is an *empty success* rather than a
 * `not-found`, `fetchArtistRelations`' rule: the lookup succeeding means the
 * artist page exists and simply lists no links, which is the ordinary state of a
 * great many artists and worth caching positively. A 404 means the MBID has been
 * merged away — a real `not-found`, cached negatively.
 */
export async function fetchArtistUrlRelations(
  client: NetClient,
  mbid: string
): Promise<NetResult<ArtistLink[]>> {
  if (!isMbid(mbid)) {
    return netFailed({ kind: 'rejected', message: 'That is not a MusicBrainz identifier.' })
  }

  const result = await client.getJson<unknown>({
    url: artistUrlRelationsUrl(mbid),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!result.ok) return result

  return netOk(parseArtistUrlRelations(result.value))
}
