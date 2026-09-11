/**
 * The Cover Art Archive, as validated image bytes — **W7-15**.
 *
 * The one genuinely new piece the two cover-art surfaces (W7-16 rip prep, W7-17
 * edit-time picker) share: a keyless fetch that turns a release MBID into a list
 * of cover candidates, and a candidate's URL into the bytes behind it. It ships
 * no storage and no validation of its own — the bytes go straight to
 * `ArtworkCacheService.setCover`, which already sniffs, decodes and content-
 * addresses them, so a network-fetched cover is indistinguishable from a file the
 * operator picked. This is the whole reason the two surface cards are thin.
 *
 * ## Two hops, two hosts
 *
 * The manifest at `coverartarchive.org/release/{mbid}` is JSON naming each cover
 * and its thumbnails. The *bytes* those URLs name do not live there: CAA
 * 307-redirects them to `archive.org` (`ia*.us.archive.org`). `NetClient` fetches
 * with `redirect: 'follow'` and its per-host rate limiter keys on the URL it was
 * handed, so following the redirect costs no second limiter slot and the image
 * transfer is never serialised behind `archive.org`'s clock — only the one CAA
 * request that starts it is gated, which is correct.
 *
 * ## A missing cover is an answer, not a failure
 *
 * Plenty of releases carry no front cover, and CAA says so with a 404 — which
 * `NetClient` maps to `not-found`, the one failure kind the cache remembers
 * negatively. The raw fetches below surface that `not-found` so it is written to
 * the negative cache and not re-asked on every open; the cached client then hands
 * the caller an empty list rather than a failure it would have to explain. This
 * is `service.ts`' idiom exactly: the network hop reports `not-found`, the layer
 * above translates it to the domain's "nothing here".
 *
 * ## Consent is at the socket, not here
 *
 * Every request goes through `NetClient`, so D14's `network.externalLookups` gate
 * is checked by construction. There is deliberately no second consent check in
 * this module or its callers.
 */

import { isMbid } from '@shared/artist'
import { MAX_ARTWORK_INGEST_BYTES, type CoverArtCandidate } from '@shared/artwork'
import { netFailed, netOk, type NetResult, type NetScope } from '@shared/net'
import type { CacheService } from '../cache'
import type { CacheEntity } from '../cache/policy'
import type { NetClient } from '../net'

/** The origin the manifest is fetched from. The bytes redirect away from it. */
const CAA_ORIGIN = 'https://coverartarchive.org'

/** Every request in this module enrols in the surface that opened the lookup. */
const COVER_ART_SCOPE: NetScope = 'cover-art'

/** One shape, two endpoints; the key says which endpoint answered. */
const COVER_ENTITY: CacheEntity = 'coverartarchive.cover'

/** A release MBID's manifest. */
function releaseCacheKey(mbid: string): string {
  return `release:${mbid}`
}

/** A release-group MBID's manifest — the representative release's front. */
function releaseGroupCacheKey(mbid: string): string {
  return `release-group:${mbid}`
}

/**
 * One image as the CAA manifest describes it. Every field is optional because
 * the document comes from a host nobody vetted: a candidate is kept only if it
 * yields a usable URL, and dropped otherwise rather than trusted.
 */
interface CaaImage {
  readonly front?: boolean
  readonly image?: string
  readonly thumbnails?: Readonly<Record<string, string>>
}

interface CaaManifest {
  readonly images?: readonly CaaImage[]
}

/** A `rejected` for an MBID that never should have reached a URL. */
function rejectedMbid(): NetResult<CoverArtCandidate[]> {
  return netFailed({ kind: 'rejected', message: 'That is not a MusicBrainz identifier.' })
}

/**
 * The thumbnail to show in a picker: a mid-size preview, falling back through
 * the sizes CAA offers to the full image if it is all there is. `500` is large
 * enough to read and small enough not to pull a multi-megabyte body to draw a
 * grid cell.
 */
function pickThumbUrl(image: CaaImage): string | null {
  const t = image.thumbnails ?? {}
  return t['500'] ?? t.large ?? t['250'] ?? t.small ?? t['1200'] ?? image.image ?? null
}

/** The full-resolution image, falling back to the largest thumbnail if absent. */
function pickFullUrl(image: CaaImage): string | null {
  const t = image.thumbnails ?? {}
  return image.image ?? t['1200'] ?? t['500'] ?? t.large ?? null
}

/**
 * A manifest becomes candidates: usable URLs only, front covers first.
 *
 * The sort is stable, so CAA's own order is preserved within the front and
 * non-front groups — a release with several fronts keeps the archive's ranking
 * of them, and only the back/booklet images are pushed down.
 */
function parseManifest(manifest: CaaManifest): CoverArtCandidate[] {
  const candidates: CoverArtCandidate[] = []
  for (const image of manifest.images ?? []) {
    const thumbUrl = pickThumbUrl(image)
    const fullUrl = pickFullUrl(image)
    if (!thumbUrl || !fullUrl) continue
    candidates.push({
      source: 'coverartarchive',
      front: image.front === true,
      thumbUrl,
      fullUrl
    })
  }
  candidates.sort((a, b) => Number(b.front) - Number(a.front))
  return candidates
}

/**
 * The front covers a release offers — **the raw hop, no cache**.
 *
 * `not-found` is surfaced rather than swallowed so the cache layer can remember
 * it; {@link createCoverArtArchiveClient} is what turns it into an empty list for
 * a caller. The MBID is validated before it reaches a URL so a malformed value
 * can never reshape the path.
 */
export function fetchReleaseFront(
  client: NetClient,
  mbid: string
): Promise<NetResult<CoverArtCandidate[]>> {
  if (!isMbid(mbid)) return Promise.resolve(rejectedMbid())
  return fetchManifest(client, `${CAA_ORIGIN}/release/${mbid}`)
}

/**
 * The representative release's front for a release group — **the raw hop, no
 * cache**. For the edit-time path, which often has only a release-group MBID in
 * hand. Same shape and same `not-found` handling as {@link fetchReleaseFront}.
 */
export function fetchReleaseGroupFront(
  client: NetClient,
  mbid: string
): Promise<NetResult<CoverArtCandidate[]>> {
  if (!isMbid(mbid)) return Promise.resolve(rejectedMbid())
  return fetchManifest(client, `${CAA_ORIGIN}/release-group/${mbid}`)
}

async function fetchManifest(
  client: NetClient,
  url: string
): Promise<NetResult<CoverArtCandidate[]>> {
  const result = await client.getJson<CaaManifest>({ url, scope: COVER_ART_SCOPE })
  if (!result.ok) return result
  return netOk(parseManifest(result.value))
}

export interface FetchImageBytesOptions {
  /** The body ceiling. Defaults to the same 32 MB the file picker enforces. */
  maxBytes?: number
}

/**
 * The bytes behind a candidate's URL — the second hop.
 *
 * Capped at {@link MAX_ARTWORK_INGEST_BYTES} by default, the same ceiling
 * `setCover` and the file picker enforce, so a hostile manifest cannot make us
 * buffer an arbitrarily large body. The redirect to `archive.org` is followed
 * inside `NetClient`; the caller passes the `coverartarchive.org` (or already
 * resolved) URL and gets bytes.
 */
export function fetchImageBytes(
  client: NetClient,
  url: string,
  { maxBytes = MAX_ARTWORK_INGEST_BYTES }: FetchImageBytesOptions = {}
): Promise<NetResult<Uint8Array>> {
  return client.getBytes({ url, scope: COVER_ART_SCOPE, maxBytes })
}

/**
 * The cover a caller picked, or an empty list — the client both surfaces use.
 *
 * The manifest fetches are wrapped in `cache.through`, so a repeated lookup for
 * the same release opens no socket and a known-empty release is not re-asked
 * until its negative entry expires. The image fetch is *not* cached here: the
 * bytes an operator actually picks become a durable override through `setCover`,
 * authoritative and surviving a cache wipe, and un-picked candidate blobs are
 * never persisted.
 */
export interface CoverArtArchiveClient {
  /** A release's covers, front first. Empty list when the release has none. */
  releaseFront(mbid: string): Promise<NetResult<CoverArtCandidate[]>>
  /** A release group's representative front. Empty list when it has none. */
  releaseGroupFront(mbid: string): Promise<NetResult<CoverArtCandidate[]>>
  /** The bytes behind a candidate URL, capped and consent-gated at the socket. */
  fetchImageBytes(url: string, options?: FetchImageBytesOptions): Promise<NetResult<Uint8Array>>
}

export interface CoverArtArchiveClientOptions {
  client: NetClient
  cache: CacheService
}

/** A `not-found` becomes an empty list; every other failure passes through. */
function emptyOnNotFound(result: NetResult<CoverArtCandidate[]>): NetResult<CoverArtCandidate[]> {
  if (result.ok) return result
  return result.failure.kind === 'not-found' ? netOk([]) : result
}

export function createCoverArtArchiveClient({
  client,
  cache
}: CoverArtArchiveClientOptions): CoverArtArchiveClient {
  return {
    async releaseFront(mbid): Promise<NetResult<CoverArtCandidate[]>> {
      return emptyOnNotFound(
        await cache.through(COVER_ENTITY, releaseCacheKey(mbid), () =>
          fetchReleaseFront(client, mbid)
        )
      )
    },

    async releaseGroupFront(mbid): Promise<NetResult<CoverArtCandidate[]>> {
      return emptyOnNotFound(
        await cache.through(COVER_ENTITY, releaseGroupCacheKey(mbid), () =>
          fetchReleaseGroupFront(client, mbid)
        )
      )
    },

    fetchImageBytes(url, options): Promise<NetResult<Uint8Array>> {
      return fetchImageBytes(client, url, options)
    }
  }
}
