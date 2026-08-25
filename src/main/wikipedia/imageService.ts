/**
 * The artist photograph, assembled: three hops, two caches and one shared
 * thumbnail directory.
 *
 * ## Where it sits
 *
 * Beside `service.ts` rather than inside it. The two share their first hop —
 * both need the Wikidata item behind a MusicBrainz identifier, and both read it
 * from the same `wikidata.entity` row, so an artist whose biography has loaded
 * costs zero extra requests to resolve — but they are separate services because
 * they fail separately. A Commons outage must not blank the biography, a
 * Wikipedia outage must not blank the picture, and the deck loads them from one
 * watcher precisely because neither blocks the other.
 *
 * ## Two blob stores would have been the easy mistake
 *
 * The card is explicit and so is D14: the picture goes into the *existing*
 * content-hashed thumbnail cache, the one album art lives in, served by the same
 * `oscine://artwork/<hash>/<variant>` route. What lands in `cache.db` is a few
 * hundred bytes naming the hash and the credit.
 *
 * That split is also what makes the eviction acceptance true. Nothing here
 * competes with album art for a budget, because the artwork directory is pruned
 * by *reference* rather than by size: album art is referenced from
 * `albums.artwork_hash` for as long as the album has tracks, and a photograph is
 * referenced from one of these rows for as long as the row survives its TTL and
 * `cache.db`'s own LRU. A month of not listening to an artist releases their
 * photograph; nothing whatsoever releases the artwork of an album you own. The
 * decoration is the thing that decays, which is the ordering the card asks for
 * and one no weighting has to be maintained to preserve.
 *
 * ## Every failure is a state
 *
 * `service.ts`' rule, unchanged. `NetResult` in, `ArtistImageResult` out, and
 * the only exceptions are database errors.
 */

import {
  ARTIST_IMAGE_WIDTH,
  type ArtistImageCredit,
  type ArtistImageResult
} from '@shared/artistImage'
import { artworkUrl } from '@shared/ipc'
import { netFailed, netOk, type NetFailure, type NetResult } from '@shared/net'
import type Database from 'better-sqlite3'
import type { CacheService } from '../cache'
import type { DerivedArtworkStore } from '../library/derivedArtwork'
import { createArtistIdentityStore } from '../musicbrainz'
import type { NetClient } from '../net'
import { fetchImageBytes, fetchImageInfo } from './commons'
import { articleLanguages } from './language'
import { entityCacheKey } from './service'
import { fetchEntityImage, resolveEntity } from './wikidata'

const ENTITY_ENTITY = 'wikidata.entity' as const
const IMAGE_ENTITY = 'commons.image' as const

/**
 * What one row of `commons.image` holds.
 *
 * The hash rather than the bytes, and the credit rather than a rendered line.
 * Keyed by Wikidata item id, not by MBID: two MusicBrainz artists can point at
 * one item — a solo career and the band page, the same collision the extract
 * cache is keyed to avoid — and they should share one download.
 */
export interface CachedArtistImage {
  /** The Commons file name, as Wikidata's P18 claim gave it. */
  file: string
  /** The key into the shared thumbnail cache. Both variants exist under it. */
  hash: string
  credit: ArtistImageCredit
}

export interface ArtistImageService {
  /** The photograph for a library artist. Never throws for a missing picture. */
  get(artistId: number): Promise<ArtistImageResult>
  /**
   * Every thumbnail hash a cache row still names.
   *
   * Handed to `ArtworkCacheService` so its prune does not delete files it has
   * no other way of knowing about. Synchronous and cheap — one indexed scan of
   * a table that holds one row per artist ever looked at.
   */
  referencedHashes(): Set<string>
}

export interface ArtistImageServiceOptions {
  db: Database.Database
  client: NetClient
  cache: CacheService
  /** The shared thumbnail cache. The same one album art is written to. */
  artwork: DerivedArtworkStore
  /** The operator's locale, as `app.getLocale()` reports it. See `service.ts`. */
  locale: () => string
}

function unavailable(artistId: number, failure: NetFailure): ArtistImageResult {
  return { artistId, status: 'unavailable', image: null, failure }
}

function none(artistId: number): ArtistImageResult {
  return { artistId, status: 'none', image: null, failure: null }
}

export function createArtistImageService({
  db,
  client,
  cache,
  artwork,
  locale
}: ArtistImageServiceOptions): ArtistImageService {
  const identities = createArtistIdentityStore(db)

  /**
   * The three remote hops, without the cache around them.
   *
   * Named separately from the `through` call because it has a second caller —
   * the repair path below, which already has a cached answer and needs a fresh
   * one regardless of what the cache would say.
   */
  async function fetchImage(entityId: string): Promise<NetResult<CachedArtistImage>> {
    const file = await fetchEntityImage(client, entityId)
    if (!file.ok) return file

    const info = await fetchImageInfo(client, file.value, ARTIST_IMAGE_WIDTH)
    if (!info.ok) return info

    const bytes = await fetchImageBytes(client, info.value.thumbUrl)
    if (!bytes.ok) return bytes

    const stored = await artwork.store(bytes.value, `Commons file ${file.value}`)
    if (!stored) {
      // The bytes arrived and sharp could not read them. Reported as
      // `not-found` rather than `malformed` on purpose: `malformed` is the kind
      // reserved for a bug in our own parsing and is deliberately *not* cached,
      // so using it here would re-download an undecodable file on every play of
      // the artist forever. This is a durable fact about one Commons file, and
      // a week in the negative cache is what it deserves. `store` has already
      // logged what sharp actually said.
      return netFailed({ kind: 'not-found', message: 'The service has nothing for this.' })
    }

    return netOk({ file: file.value, hash: stored.hash, credit: info.value.credit })
  }

  return {
    async get(artistId): Promise<ArtistImageResult> {
      const mbid = identities.byId(artistId)?.mbid
      if (!mbid) return none(artistId)

      // The same key the biography writes, so the item is already known for any
      // artist whose prose has loaded — which, given both load from one
      // watcher, is every artist the deck has finished looking at.
      const languages = articleLanguages(locale())
      const entity = await cache.through(ENTITY_ENTITY, entityCacheKey(mbid, languages), () =>
        resolveEntity(client, mbid, languages)
      )
      if (!entity.ok) {
        return entity.failure.kind === 'not-found'
          ? none(artistId)
          : unavailable(artistId, entity.failure)
      }

      const entityId = entity.value.entityId
      const cached = await cache.through<CachedArtistImage>(IMAGE_ENTITY, entityId, () =>
        fetchImage(entityId)
      )
      if (!cached.ok) {
        return cached.failure.kind === 'not-found'
          ? none(artistId)
          : unavailable(artistId, cached.failure)
      }

      let image = cached.value

      // The row and the file can disagree, in one direction. `cache.db` and the
      // artwork directory are separate stores with separate lifetimes: a prune
      // that ran while this row was briefly unreadable, an operator who deleted
      // the thumbnail cache, a half-written file from a crash. The row is then a
      // hash pointing at nothing, and rendering it would produce the artwork
      // placeholder under an attribution line for a picture that is not there.
      // Cheap to check — a stat per variant — and only ever wrong once.
      if (!(await artwork.has(image.hash))) {
        const repaired = await fetchImage(entityId)
        if (!repaired.ok) {
          return repaired.failure.kind === 'not-found'
            ? none(artistId)
            : unavailable(artistId, repaired.failure)
        }
        cache.writeValue(IMAGE_ENTITY, entityId, repaired.value)
        image = repaired.value
      }

      return {
        artistId,
        status: 'ready',
        image: {
          entityId,
          file: image.file,
          small: artworkUrl(image.hash, 'small'),
          large: artworkUrl(image.hash, 'large'),
          credit: image.credit
        },
        failure: null
      }
    },

    referencedHashes(): Set<string> {
      const hashes = new Set<string>()
      for (const row of cache.values<CachedArtistImage>(IMAGE_ENTITY)) {
        if (typeof row?.hash === 'string') hashes.add(row.hash)
      }
      return hashes
    }
  }
}
