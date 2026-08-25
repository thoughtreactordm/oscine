/**
 * Apple iTunes Search / Lookup / genre charts for Discover.
 *
 * Keyless, main-process only. Hits are catalogue metadata plus a feed URL —
 * subscribe still goes through the existing RSS path. Chart RSS entries do not
 * carry feed URLs, so recommendations always finish with a lookup.
 */

import { OscineError } from '@shared/errors'
import type { PodcastCatalogHit } from '@shared/podcasts'
import { OSCINE_USER_AGENT } from '../net/http'
import type { NetworkConsent } from '../net'

const ITUNES_TIMEOUT_MS = 15_000
/** Apple's root "Podcasts" genre — noise for recommendation weighting. */
const PODCASTS_ROOT_GENRE_ID = '26'
const DEFAULT_COUNTRY = 'us'
const MAX_SEARCH_RESULTS = 25
const MAX_CHART_ENTRIES = 25
const MAX_LOOKUP_BATCH = 40

export interface ItunesClient {
  search(term: string, limit?: number): Promise<PodcastCatalogHit[]>
  lookupIds(ids: number[]): Promise<PodcastCatalogHit[]>
  chart(genreId: string, limit?: number): Promise<Array<{ collectionId: number; title: string }>>
}

export interface ItunesClientDeps {
  fetchImpl?: typeof fetch
  country?: string
  userAgent?: string
  /**
   * **D14**'s first rule, at the socket. When present and denied, no request
   * leaves — the same gate `NetClient` bakes in for MusicBrainz and Wikipedia,
   * applied to Apple's catalogue. Omitted only by tests exercising transport
   * and parsing; every production client is built with it in `service.ts`.
   */
  consent?: NetworkConsent
}

export function createItunesClient(deps: ItunesClientDeps = {}): ItunesClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const country = deps.country ?? DEFAULT_COUNTRY
  const userAgent = deps.userAgent ?? OSCINE_USER_AGENT
  const consent = deps.consent

  async function getJson(url: string): Promise<unknown> {
    // Checked here rather than in the panes that want the data: a rule enforced
    // at the point of display is one a new caller can forget, and forgetting
    // this one means a request left the machine before the operator agreed to
    // it. Read live, so switching the toggle off stops fetching without a
    // restart. See `net/consent.ts`.
    if (consent && !consent.granted()) {
      throw new OscineError('io-error', 'Online catalogue lookups are turned off.')
    }
    let response: Response
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(ITUNES_TIMEOUT_MS),
        headers: { accept: 'application/json', 'user-agent': userAgent }
      })
    } catch {
      throw new OscineError('io-error', 'Could not reach the Apple podcast catalogue.')
    }
    if (!response.ok) {
      throw new OscineError('io-error', `Apple catalogue returned HTTP ${response.status}.`)
    }
    try {
      return (await response.json()) as unknown
    } catch {
      throw new OscineError('io-error', 'Apple catalogue returned invalid JSON.')
    }
  }

  return {
    async search(term: string, limit = MAX_SEARCH_RESULTS): Promise<PodcastCatalogHit[]> {
      const q = term.trim()
      if (q === '') return []
      const capped = Math.min(Math.max(1, limit), MAX_SEARCH_RESULTS)
      const url =
        `https://itunes.apple.com/search?media=podcast&entity=podcast` +
        `&country=${encodeURIComponent(country)}` +
        `&limit=${capped}` +
        `&term=${encodeURIComponent(q)}`
      const body = await getJson(url)
      return parseSearchResults(body)
    },

    async lookupIds(ids: number[]): Promise<PodcastCatalogHit[]> {
      const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
      if (unique.length === 0) return []
      const hits: PodcastCatalogHit[] = []
      for (let i = 0; i < unique.length; i += MAX_LOOKUP_BATCH) {
        const batch = unique.slice(i, i + MAX_LOOKUP_BATCH)
        const url =
          `https://itunes.apple.com/lookup?entity=podcast` +
          `&country=${encodeURIComponent(country)}` +
          `&id=${batch.join(',')}`
        const body = await getJson(url)
        hits.push(...parseSearchResults(body))
      }
      return hits
    },

    async chart(
      genreId: string,
      limit = MAX_CHART_ENTRIES
    ): Promise<Array<{ collectionId: number; title: string }>> {
      const id = genreId.trim()
      if (!/^\d+$/.test(id) || id === PODCASTS_ROOT_GENRE_ID) return []
      const capped = Math.min(Math.max(1, limit), MAX_CHART_ENTRIES)
      // `toppodcasts`, not `topaudiopodcasts`. Apple still serves the audio-only
      // generator, but its genre-scoped output has decayed to nothing: measured
      // against all eighteen browse categories it returned 0 entries for twelve
      // of them and 2-5 for most of the rest, while `toppodcasts` returned a
      // full 25 for every one. Same JSON shape, same `im:id` attribute, and the
      // ids still resolve through /lookup with feed URLs, so only the path
      // changes. If a category ever comes back empty again, check this endpoint
      // against a browser before suspecting the parser.
      const url =
        `https://itunes.apple.com/${encodeURIComponent(country)}` +
        `/rss/toppodcasts/limit=${capped}/genre=${encodeURIComponent(id)}/json`
      const body = await getJson(url)
      return parseChartEntries(body)
    }
  }
}

export function parseSearchResults(body: unknown): PodcastCatalogHit[] {
  if (!isRecord(body) || !Array.isArray(body.results)) return []
  const hits: PodcastCatalogHit[] = []
  for (const row of body.results) {
    const hit = catalogHitFromResult(row)
    if (hit) hits.push(hit)
  }
  return hits
}

export function parseChartEntries(body: unknown): Array<{ collectionId: number; title: string }> {
  if (!isRecord(body) || !isRecord(body.feed) || !Array.isArray(body.feed.entry)) return []
  const entries: Array<{ collectionId: number; title: string }> = []
  for (const row of body.feed.entry) {
    if (!isRecord(row)) continue
    const idNode = isRecord(row.id) ? row.id : null
    const attrs = idNode && isRecord(idNode.attributes) ? idNode.attributes : null
    const rawId = attrs?.['im:id']
    const collectionId =
      typeof rawId === 'string' ? Number(rawId) : typeof rawId === 'number' ? rawId : NaN
    if (!Number.isInteger(collectionId) || collectionId <= 0) continue
    const nameNode = isRecord(row['im:name']) ? row['im:name'] : null
    const title =
      (typeof nameNode?.label === 'string' && nameNode.label.trim() !== ''
        ? nameNode.label.trim()
        : null) ??
      (isRecord(row.title) && typeof row.title.label === 'string' ? row.title.label.trim() : '')
    if (title === '') continue
    entries.push({ collectionId, title })
  }
  return entries
}

export function catalogHitFromResult(row: unknown): PodcastCatalogHit | null {
  if (!isRecord(row)) return null
  if (row.kind !== undefined && row.kind !== 'podcast') return null

  const feedUrl = typeof row.feedUrl === 'string' ? row.feedUrl.trim() : ''
  if (feedUrl === '') return null
  try {
    const url = new URL(feedUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }

  const collectionId = asPositiveInt(row.collectionId) ?? asPositiveInt(row.trackId)
  if (collectionId === null) return null

  const title =
    (typeof row.collectionName === 'string' && row.collectionName.trim()) ||
    (typeof row.trackName === 'string' && row.trackName.trim()) ||
    ''
  if (title === '') return null

  const author =
    typeof row.artistName === 'string' && row.artistName.trim() !== ''
      ? row.artistName.trim()
      : null

  const artworkUrl =
    (typeof row.artworkUrl600 === 'string' && row.artworkUrl600) ||
    (typeof row.artworkUrl100 === 'string' && row.artworkUrl100) ||
    null

  const primaryGenreName =
    typeof row.primaryGenreName === 'string' && row.primaryGenreName.trim() !== ''
      ? row.primaryGenreName.trim()
      : null

  const rawGenres = Array.isArray(row.genres) ? row.genres : []
  const rawGenreIds = Array.isArray(row.genreIds) ? row.genreIds : []
  // Keep names parallel to ids after dropping the Podcasts root (id "26").
  const genres: string[] = []
  const genreIds: string[] = []
  const len = Math.max(rawGenres.length, rawGenreIds.length)
  for (let i = 0; i < len; i++) {
    const rawId = rawGenreIds[i]
    const id =
      typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : ''
    if (!/^\d+$/.test(id) || id === PODCASTS_ROOT_GENRE_ID) continue
    const rawName = rawGenres[i]
    const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : id
    genreIds.push(id)
    genres.push(name)
  }

  return {
    collectionId,
    feedUrl: new URL(feedUrl).toString(),
    title,
    author,
    artworkUrl,
    primaryGenreName,
    genres,
    genreIds
  }
}

/** Genres worth aggregating for recommendations (excludes the Podcasts root). */
export function usefulGenreIds(hit: PodcastCatalogHit): string[] {
  return hit.genreIds.filter((id) => id !== PODCASTS_ROOT_GENRE_ID)
}

export function normalizeCatalogFeedUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }
    return url.toString()
  } catch {
    return raw.trim()
  }
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 ? n : null
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
