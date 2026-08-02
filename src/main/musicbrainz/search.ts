/**
 * The MusicBrainz artist search: one request, and the parsing of its reply.
 *
 * Keyless, as **D14** requires — no secret ships in the bundle and nothing has
 * to be pasted by an operator. The identifying User-Agent MusicBrainz asks for
 * is the client's, and the one-request-per-second ceiling is the limiter's;
 * neither is this file's business, which is why this file is short.
 *
 * Everything is parsed defensively. The reply is a JSON document from a service
 * we do not control, and a missing `disambiguation` on one artist out of eleven
 * must cost that artist a subtitle rather than cost the operator a blank pane —
 * so every field past the identifier is optional and a candidate without a
 * usable `id` or `name` is dropped rather than repaired.
 */

import { ARTIST_CANDIDATE_LIMIT, isMbid } from '@shared/artist'
import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { escapeLucene } from './artistName'

/** The web service root. Versioned by MusicBrainz, so the `/2` is theirs. */
export const MUSICBRAINZ_WS = 'https://musicbrainz.org/ws/2'

/**
 * How many candidates to ask for.
 *
 * Twelve, and the number is not arbitrary: eleven artists are called "Nirvana",
 * and a picker that cannot show all of them is a picker that cannot resolve the
 * case R5 uses as its worked example. It is also `ARTIST_CANDIDATE_LIMIT`, so
 * nothing is fetched that the picker would then discard.
 */
const SEARCH_LIMIT = ARTIST_CANDIDATE_LIMIT

/** What the search gives us about one artist, before scoring. */
export interface SearchedArtist {
  mbid: string
  name: string
  sortName: string | null
  disambiguation: string | null
  country: string | null
  type: string | null
  begin: string | null
  end: string | null
  /** Every name this artist also answers to. Carries the transliterations. */
  aliases: string[]
  /** MusicBrainz's own relevance score, 0–100. */
  searchScore: number
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * MusicBrainz's `score` arrives as a number in JSON and as a string in some
 * older documents. Clamped rather than trusted: a score of 1000 would sail past
 * every threshold in `score.ts`.
 */
function asScore(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return 0
  return Math.min(100, Math.max(0, Math.round(parsed)))
}

function readAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const name = asString(record.name)
    if (name) names.push(name)
    const sortName = asString(record['sort-name'])
    // The sort form of an alias is a different string that means the same
    // artist, and for a transliterated alias it is frequently the *only* form
    // written the way a Western tagger would write it.
    if (sortName && sortName !== name) names.push(sortName)
  }
  return names
}

/**
 * Reads the `artists` array out of a search document.
 *
 * Exported because the fixture set exercises it directly: the hard cases in R5
 * are hard at this layer as much as at the scoring layer, and a test that has to
 * stand up a fake `NetClient` to assert that a non-Latin name survived parsing
 * is a test about plumbing.
 */
export function parseArtistSearch(body: unknown): SearchedArtist[] {
  const document = asRecord(body)
  const raw = document?.artists
  if (!Array.isArray(raw)) return []

  const artists: SearchedArtist[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue

    const mbid = asString(record.id)
    const name = asString(record.name)
    // Both are load-bearing: an entry without an identifier cannot be stored on
    // the artists row, and one without a name cannot be scored or shown.
    if (!mbid || !isMbid(mbid) || !name) continue

    const lifeSpan = asRecord(record['life-span'])

    artists.push({
      mbid,
      name,
      sortName: asString(record['sort-name']),
      disambiguation: asString(record.disambiguation),
      country: asString(record.country),
      type: asString(record.type),
      begin: lifeSpan ? asString(lifeSpan.begin) : null,
      end: lifeSpan ? asString(lifeSpan.end) : null,
      aliases: readAliases(record.aliases),
      searchScore: asScore(record.score)
    })

    if (artists.length >= SEARCH_LIMIT) break
  }
  return artists
}

/**
 * Builds the search URL for a name.
 *
 * `fmt=json` because the default is XML and we would rather not carry a parser.
 * The query is Lucene-escaped, which is the difference between searching for
 * "Sunn O)))" and receiving a 400 — and a 400 is a `rejected`, which the deck
 * reads as a bug on our side rather than as an artist it cannot find. It would
 * be right about that.
 */
export function artistSearchUrl(query: string): string {
  const params = new URLSearchParams({
    query: escapeLucene(query),
    fmt: 'json',
    limit: String(SEARCH_LIMIT)
  })
  return `${MUSICBRAINZ_WS}/artist?${params.toString()}`
}

/**
 * Searches MusicBrainz for a name.
 *
 * An empty `artists` array becomes `not-found` rather than an empty success,
 * which is what routes it into the negative cache. That is the difference
 * between an unmatchable tag costing one request a week and costing one request
 * per play — the single most load-bearing consequence in `cache/policy.ts`, and
 * the traffic pattern R5's secondary risk is about.
 */
export async function searchArtists(
  client: NetClient,
  query: string
): Promise<NetResult<SearchedArtist[]>> {
  const result = await client.getJson<unknown>({
    url: artistSearchUrl(query),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!result.ok) return result

  const artists = parseArtistSearch(result.value)
  if (artists.length === 0) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }
  return netOk(artists)
}
