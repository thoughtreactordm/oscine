/**
 * Apple's album covers, as picker candidates — **W7-17**'s fallback source.
 *
 * The Cover Art Archive is the edit-time picker's primary source, but plenty of
 * releases MusicBrainz has never heard of still have covers, and Apple's keyless
 * Search API answers `entity=album` with one for most of them. This is the "no
 * MusicBrainz match?" affordance.
 *
 * ## Why this does not reuse `podcasts/itunes.ts`
 *
 * That client speaks the same Search API, but over its own socket and consent
 * check, and it returns `PodcastCatalogHit`. The edit-time picker runs on the
 * `cover-art` scope so that closing it abandons in-flight lookups, which means
 * the request must go through `NetClient` — the one place the scope registry and
 * D14's consent gate live. So this is a thin album-shaped reader over the shared
 * client rather than a second method on the podcast one.
 *
 * ## The `artworkUrl100` upscale
 *
 * Apple returns a 100px `artworkUrl100` on every result and a 600px
 * `artworkUrl600` on most. The size is a path segment (`.../100x100bb.jpg`), so
 * a larger cover is a URL rewrite, not a second request: {@link resizeItunesArtwork}
 * swaps the segment, and the picker asks for a 600px full image and a 300px
 * thumbnail off the same base. The bytes still cross only when the operator
 * picks — the URLs are addresses, like every candidate.
 */

import type { CoverArtCandidate } from '@shared/artwork'
import { netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../net'

/** The edit-time picker enrols its lookups here; see the module comment. */
const COVER_ART_SCOPE = 'cover-art' as const

/** Apple's keyless catalogue search. */
const ITUNES_SEARCH = 'https://itunes.apple.com/search'

/** A generous grid: enough alternatives to be a fallback, not a firehose. */
const ALBUM_LIMIT = 12

/** The full-resolution size the picker pulls on a pick. 600 is Apple's own top tier. */
const FULL_SIZE = 600
/** The preview size — readable in a grid cell without pulling the full image. */
const THUMB_SIZE = 300

interface ItunesAlbumResult {
  readonly collectionName?: string
  readonly artistName?: string
  readonly artworkUrl100?: string
  readonly artworkUrl600?: string
}

interface ItunesSearchBody {
  readonly results?: readonly ItunesAlbumResult[]
}

/**
 * Rewrites an iTunes artwork URL to a square size, or returns it unchanged when
 * it is not the shape we know. The size lives in a `NNNxNNNbb` path segment; only
 * that segment moves, so the CDN host and cache key are untouched.
 */
export function resizeItunesArtwork(url: string, size: number): string {
  return url.replace(/\/\d+x\d+bb(\.\w+)(?:\?.*)?$/u, `/${size}x${size}bb$1`)
}

/** One search result becomes a candidate, or null when it names no usable cover. */
function candidateFromResult(result: ItunesAlbumResult): CoverArtCandidate | null {
  const base =
    (typeof result.artworkUrl600 === 'string' && result.artworkUrl600) ||
    (typeof result.artworkUrl100 === 'string' && result.artworkUrl100) ||
    null
  if (!base) return null
  const title = typeof result.collectionName === 'string' ? result.collectionName.trim() : ''
  const artist = typeof result.artistName === 'string' ? result.artistName.trim() : ''
  return {
    source: 'itunes',
    // Apple returns cover art, never back/booklet scans, so every result is a front.
    front: true,
    thumbUrl: resizeItunesArtwork(base, THUMB_SIZE),
    fullUrl: resizeItunesArtwork(base, FULL_SIZE),
    title: title === '' ? undefined : title,
    detail: artist === '' ? undefined : artist,
    width: FULL_SIZE,
    height: FULL_SIZE
  }
}

/** Reads Apple's `results` array into candidates, dropping any without a cover. */
export function parseItunesAlbumSearch(body: unknown): CoverArtCandidate[] {
  const results = (body as ItunesSearchBody | null)?.results
  if (!Array.isArray(results)) return []
  const candidates: CoverArtCandidate[] = []
  for (const result of results) {
    const candidate = candidateFromResult(result)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}

function albumSearchUrl(artist: string, album: string): string {
  const term = `${artist} ${album}`.trim()
  const params = new URLSearchParams({
    media: 'music',
    entity: 'album',
    limit: String(ALBUM_LIMIT),
    term
  })
  return `${ITUNES_SEARCH}?${params.toString()}`
}

/**
 * Searches Apple's catalogue for album covers matching an artist and album.
 *
 * Runs on the `cover-art` scope through the shared client, so consent and
 * cancellation are handled at the socket. Any failure — including consent
 * denied, which the client reports rather than throwing — becomes an empty list:
 * a fallback that cannot reach Apple simply offers nothing, and the picker still
 * shows whatever the Cover Art Archive found and the file picker beside it.
 */
export async function searchItunesAlbumCovers(
  client: NetClient,
  artist: string,
  album: string
): Promise<NetResult<CoverArtCandidate[]>> {
  if (artist.trim() === '' && album.trim() === '') return netOk([])
  const result = await client.getJson<unknown>({
    url: albumSearchUrl(artist, album),
    scope: COVER_ART_SCOPE,
    accept: 'application/json'
  })
  if (!result.ok) return netOk([])
  return netOk(parseItunesAlbumSearch(result.value))
}
