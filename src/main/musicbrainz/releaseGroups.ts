/**
 * Corroborating an artist identity against the albums we already hold.
 *
 * ## The problem this exists for
 *
 * `score.ts` explains why a threshold and a margin cannot separate eleven
 * artists called "Nirvana". What it did not anticipate is how *often* that
 * situation arises: measured against live MusicBrainz replies, "Led Zeppelin",
 * "Pink Floyd", "The Beatles" and "Radiohead" all come back ambiguous. Every
 * well-known artist has tribute bands, namesakes and covers projects, and all of
 * them match the name exactly — so the name score ties at 100 and the entire
 * verdict falls onto a quarter-weighted relevance figure. Led Zeppelin loses to
 * a tribute act called "Led Zeppelin2" by nine points against a ten-point
 * margin.
 *
 * A picker that opens for Led Zeppelin is a picker nobody believes.
 *
 * ## Why this is one request and not eleven
 *
 * `score.ts` deferred corroboration on the grounds that it "costs one request
 * per candidate", which was wrong. MusicBrainz's release-group search takes a
 * Lucene query and returns the artist credit inline, so every local album title
 * goes into a single request and every candidate is answered at once:
 *
 *     artist:"Led Zeppelin" AND (releasegroup:"Led Zeppelin IV"
 *       OR releasegroup:"Houses of the Holy" OR releasegroup:"Physical Graffiti")
 *
 * Eight release groups come back, every one credited to the real Led Zeppelin
 * and none to the tribute band. That is one request, fired only when the name
 * alone was not enough, cached, and then written to the `artists` row so it
 * never happens again for that artist.
 *
 * ## What it deliberately does not do
 *
 * It does not lower any bar. Corroboration can only ever promote a candidate
 * that already cleared `ARTIST_MATCH_THRESHOLD` — see `corroborate` in
 * `score.ts`. R5's rule is that a wrong biography is worse than none, and adding
 * evidence keeps that rule while relaxing the margin would break it.
 */

import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'
import { escapeLucene } from './artistName'
import { MUSICBRAINZ_WS } from './search'

/**
 * How many local albums to put in the query.
 *
 * Four. The query is a URL parameter and each title adds thirty-odd characters,
 * but the real limit is precision rather than length: the titles are ordered
 * best-evidence-first by the store, so the fifth is a compilation the artist has
 * one track on, and a compilation corroborates whoever else is on it.
 *
 * One album is enough to settle Led Zeppelin. Four is enough that an artist
 * whose best-known record happens to be missing from MusicBrainz still gets an
 * answer.
 */
export const CORROBORATION_ALBUM_LIMIT = 4

/** How many release groups to read back. Generous: they are counted, not shown. */
const RELEASE_GROUP_LIMIT = 25

/** One release group, reduced to the two things corroboration needs. */
export interface CreditedReleaseGroup {
  title: string
  /** Every artist MusicBrainz credits it to. A collaboration credits several. */
  artistMbids: string[]
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
 * The Lucene query, or `null` when there is nothing to ask.
 *
 * Both halves are escaped and quoted. Quoting is what keeps "Houses of the Holy"
 * one phrase rather than three optional words — without it the query matches any
 * release group containing "of", which is a corroboration signal that
 * corroborates everything.
 */
export function releaseGroupQuery(artist: string, albums: readonly string[]): string | null {
  const titles = albums.map((title) => title.trim()).filter((title) => title !== '')
  if (artist.trim() === '' || titles.length === 0) return null

  const clauses = titles.map((title) => `releasegroup:"${escapeLucene(title)}"`)
  return `artist:"${escapeLucene(artist)}" AND (${clauses.join(' OR ')})`
}

export function releaseGroupSearchUrl(query: string): string {
  const params = new URLSearchParams({
    query,
    fmt: 'json',
    limit: String(RELEASE_GROUP_LIMIT)
  })
  return `${MUSICBRAINZ_WS}/release-group?${params.toString()}`
}

/**
 * The cache key for a corroboration request.
 *
 * The artist and the titles that were actually asked about, casefolded and
 * order-independent. Order-independent because the store ranks albums by track
 * count, and one more play of one track can reorder two of them — which would
 * otherwise miss the cache and spend a request to receive the same reply.
 */
export function releaseGroupCacheKey(artist: string, albums: readonly string[]): string {
  const titles = albums
    .map((title) => title.replace(/\s+/gu, ' ').trim().toLowerCase())
    .filter((title) => title !== '')
    .sort()
  return `${artist.replace(/\s+/gu, ' ').trim().toLowerCase()}|${titles.join('|')}`
}

/** Reads the `release-groups` array, keeping only entries with a real credit. */
export function parseReleaseGroupSearch(body: unknown): CreditedReleaseGroup[] {
  const raw = asRecord(body)?.['release-groups']
  if (!Array.isArray(raw)) return []

  const groups: CreditedReleaseGroup[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue

    const title = asString(record.title)
    if (!title) continue

    const credits = record['artist-credit']
    if (!Array.isArray(credits)) continue

    const artistMbids: string[] = []
    for (const credit of credits) {
      const artist = asRecord(asRecord(credit)?.artist)
      const mbid = artist ? asString(artist.id) : null
      // Duplicated credits are real — a remix crediting the same artist twice —
      // and would otherwise let one release group vote twice for one candidate.
      if (mbid && !artistMbids.includes(mbid)) artistMbids.push(mbid)
    }
    if (artistMbids.length === 0) continue

    groups.push({ title, artistMbids })
  }
  return groups
}

/**
 * Asks MusicBrainz which artists made the albums we hold.
 *
 * An empty reply is `not-found` rather than an empty success, for
 * `searchArtists`' reason: it is the negative cache that stops an artist whose
 * albums MusicBrainz has never heard of from costing a second request on every
 * play.
 */
export async function searchReleaseGroups(
  client: NetClient,
  artist: string,
  albums: readonly string[]
): Promise<NetResult<CreditedReleaseGroup[]>> {
  const query = releaseGroupQuery(artist, albums)
  if (query === null) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }

  const result = await client.getJson<unknown>({
    url: releaseGroupSearchUrl(query),
    scope: 'tunedeck',
    accept: 'application/json'
  })
  if (!result.ok) return result

  const groups = parseReleaseGroupSearch(result.value)
  if (groups.length === 0) {
    return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
  }
  return netOk(groups)
}

/**
 * One release group as the edit-time cover picker needs it — **W7-17**.
 *
 * Corroboration ({@link CreditedReleaseGroup}) throws the release-group MBID
 * away because it only counts artist credits. The picker needs the opposite: the
 * MBID, to hand to the Cover Art Archive, and enough of a caption for the
 * operator to tell two editions of the same album apart. Same search endpoint,
 * a different projection of the reply.
 */
export interface ReleaseGroupCandidate {
  /** The release-group MBID — the key the Cover Art Archive front lookup takes. */
  mbid: string
  title: string
  /** The credited artist, joined across a collaboration; null when unstated. */
  artist: string | null
  /** A disambiguation or first-release year, for the picker's second caption line. */
  detail: string | null
  /** MusicBrainz's relevance score, 0–100. Candidates are returned best-first. */
  score: number
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Joins an `artist-credit` array into a single credit line, honouring join phrases. */
function joinArtistCredit(credits: unknown): string | null {
  if (!Array.isArray(credits)) return null
  let out = ''
  for (const credit of credits) {
    const record = asRecord(credit)
    if (!record) continue
    const name = asString(record.name) ?? asString(asRecord(record.artist)?.name)
    if (name) out += name
    const join = typeof record.joinphrase === 'string' ? record.joinphrase : ''
    out += join
  }
  const trimmed = out.trim()
  return trimmed === '' ? null : trimmed
}

/** The year from a `first-release-date`, which MusicBrainz gives as `YYYY`, `YYYY-MM` or full. */
function firstReleaseYear(value: unknown): string | null {
  const date = asString(value)
  const match = date?.match(/^(\d{4})/u)
  return match ? match[1] : null
}

/**
 * Reads the `release-groups` array into ranked picker candidates.
 *
 * Unlike {@link parseReleaseGroupSearch}, an entry with no artist credit is kept
 * (the picker shows the title alone) — the only requirement is a real MBID, the
 * one field the cover lookup cannot do without.
 */
export function parseReleaseGroupCandidates(body: unknown): ReleaseGroupCandidate[] {
  const raw = asRecord(body)?.['release-groups']
  if (!Array.isArray(raw)) return []

  const candidates: ReleaseGroupCandidate[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    if (!record) continue
    const mbid = asString(record.id)
    const title = asString(record.title)
    if (!mbid || !title) continue
    candidates.push({
      mbid,
      title,
      artist: joinArtistCredit(record['artist-credit']),
      detail: asString(record.disambiguation) ?? firstReleaseYear(record['first-release-date']),
      score: asNumber(record.score)
    })
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

/**
 * Finds release groups matching an artist and one album title — **W7-17**.
 *
 * The edit-time picker's first hop: an indexed track carries no release MBID, so
 * the release group is found by name here and its front cover resolved from the
 * Cover Art Archive after. Runs on the `cover-art` scope so closing the picker
 * abandons it, and returns an empty list rather than a failure when there is
 * simply no match — a missing album is a normal answer for a picker, the same
 * stance the Cover Art Archive takes for a release with no cover.
 */
export async function searchReleaseGroupCandidates(
  client: NetClient,
  artist: string,
  album: string
): Promise<NetResult<ReleaseGroupCandidate[]>> {
  const query = releaseGroupQuery(artist, [album])
  if (query === null) return netOk([])

  const result = await client.getJson<unknown>({
    url: releaseGroupSearchUrl(query),
    scope: 'cover-art',
    accept: 'application/json'
  })
  if (!result.ok) {
    return result.failure.kind === 'not-found' ? netOk([]) : result
  }
  return netOk(parseReleaseGroupCandidates(result.value))
}
