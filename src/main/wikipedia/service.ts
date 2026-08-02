/**
 * The biography, assembled: the row, two hops, the cache and the empty states.
 *
 * ## Where the MBID comes from
 *
 * The `artists` row, never the request. The renderer sends an artist id and this
 * reads the identifier W7-9 stored — which means a correction made in the picker
 * changes which biography loads without the biography layer knowing that the
 * picker exists, and a renderer holding a stale resolution cannot pull the
 * biography of an artist the operator has already overruled.
 *
 * An artist with no MBID is answered `none` without a request. That is not a
 * shortcut: an unresolved artist is R5's first-class state, and asking Wikidata
 * about an identifier we do not have is not a thing that can be done.
 *
 * ## Two cache entities, one lookup
 *
 * `wikidata.entity` holds the join and `wikipedia.extract` holds the prose, and
 * they are separate because they expire on different clocks and because the
 * second is shared: two artists whose Wikidata items point at the same article —
 * a solo career and the band's own page, which happens — read one cached
 * extract. Keyed by language and title rather than by MBID for exactly that
 * reason.
 *
 * Both negative cases the card names land in the cache. An artist with no
 * Wikidata item is a `not-found` from the first hop, cached negatively for a
 * week. An artist with an item and no article in any language we asked for is a
 * *successful* first hop with no sitelinks, cached positively for a fortnight —
 * the item exists, and its lack of an article is a fact about it rather than an
 * absence of one. Either way the steady-state cost of a biography-less artist is
 * nothing, which is the traffic pattern R5's secondary risk is about.
 *
 * ## Every failure is a state
 *
 * Nothing here throws for a network reason, for `musicbrainz/service.ts`'
 * reason. `NetResult` comes in, an `ArtistBiographyResult` goes out, and the
 * only exceptions are database errors.
 */

import type { ArtistBiography, ArtistBiographyResult } from '@shared/biography'
import type { NetFailure } from '@shared/net'
import type Database from 'better-sqlite3'
import type { CacheService } from '../cache'
import { createArtistIdentityStore } from '../musicbrainz'
import type { NetClient } from '../net'
import { fetchExtract } from './extract'
import { articleLanguages } from './language'
import { resolveEntity, type Sitelink, type WikidataEntity } from './wikidata'

const ENTITY_ENTITY = 'wikidata.entity' as const
const EXTRACT_ENTITY = 'wikipedia.extract' as const

export interface ArtistBiographyService {
  /** The biography for a library artist. Never throws for a missing article. */
  get(artistId: number): Promise<ArtistBiographyResult>
}

export interface ArtistBiographyServiceOptions {
  db: Database.Database
  client: NetClient
  cache: CacheService
  /**
   * The operator's locale, as `app.getLocale()` reports it.
   *
   * A getter rather than a string because the service is built during startup
   * and the locale is a property of the running app; a value captured here would
   * be whatever Electron had decided at construction time.
   */
  locale: () => string
}

/**
 * The cache key for the first hop.
 *
 * The languages are part of it. The reply is `sitefilter`ed to them, so a cached
 * entity records "no article in *these* languages" rather than "no article" —
 * answering a differently-configured machine from it would be answering a
 * question it was never asked.
 */
export function entityCacheKey(mbid: string, languages: readonly string[]): string {
  return `${mbid}/${languages.join(',')}`
}

/** The cache key for the second hop. Shared across artists; see above. */
export function extractCacheKey(lang: string, title: string): string {
  return `${lang}/${title}`
}

/** A failure the pane should show as a failure rather than as an empty state. */
function unavailable(artistId: number, failure: NetFailure): ArtistBiographyResult {
  return { artistId, status: 'unavailable', biography: null, failure }
}

/** No article, for any of the several ordinary reasons. */
function none(artistId: number): ArtistBiographyResult {
  return { artistId, status: 'none', biography: null, failure: null }
}

export function createArtistBiographyService({
  db,
  client,
  cache,
  locale
}: ArtistBiographyServiceOptions): ArtistBiographyService {
  const identities = createArtistIdentityStore(db)

  async function entityFor(
    mbid: string,
    languages: readonly string[]
  ): Promise<{ entity: WikidataEntity | null; failure: NetFailure | null }> {
    const result = await cache.through<WikidataEntity>(
      ENTITY_ENTITY,
      entityCacheKey(mbid, languages),
      () => resolveEntity(client, mbid, languages)
    )
    if (result.ok) return { entity: result.value, failure: null }

    // The artist has no Wikidata item. An answer, not a failure — and one the
    // cache has already remembered for a week.
    if (result.failure.kind === 'not-found') return { entity: null, failure: null }
    return { entity: null, failure: result.failure }
  }

  /**
   * The first article that has an extract, in preference order.
   *
   * The loop matters more than it looks. A Wikidata item can carry a `dewiki`
   * sitelink pointing at a page whose lead the extension will not render — a
   * redirect to a list, a stub that is entirely infobox — and stopping at the
   * first sitelink would then show nothing for an artist with a perfectly good
   * English article. A `not-found` on one language is a reason to try the next,
   * whereas a network failure is a reason to stop: the next request would fail
   * the same way, and trying it anyway is how one unreachable host becomes two.
   */
  async function extractFor(
    sitelinks: readonly Sitelink[]
  ): Promise<{ biography: Omit<ArtistBiography, 'entityId'> | null; failure: NetFailure | null }> {
    for (const link of sitelinks) {
      const result = await cache.through(
        EXTRACT_ENTITY,
        extractCacheKey(link.lang, link.title),
        () => fetchExtract(client, link.lang, link.title)
      )

      if (result.ok) {
        return {
          biography: {
            title: result.value.title,
            lang: link.lang,
            url: link.url,
            extract: result.value.text
          },
          failure: null
        }
      }
      if (result.failure.kind !== 'not-found') return { biography: null, failure: result.failure }
    }
    return { biography: null, failure: null }
  }

  return {
    async get(artistId): Promise<ArtistBiographyResult> {
      const identity = identities.byId(artistId)
      // The artist left the library while the deck was looking at it, or was
      // never resolved. Both are `none` rather than a throw, for the reason
      // `artist.resolve` answers a vanished track with `null`.
      if (!identity?.mbid) return none(artistId)

      const languages = articleLanguages(locale())

      const { entity, failure } = await entityFor(identity.mbid, languages)
      if (failure) return unavailable(artistId, failure)
      if (!entity || entity.sitelinks.length === 0) return none(artistId)

      const found = await extractFor(entity.sitelinks)
      if (found.failure) return unavailable(artistId, found.failure)
      if (!found.biography) return none(artistId)

      return {
        artistId,
        status: 'ready',
        biography: { entityId: entity.entityId, ...found.biography },
        failure: null
      }
    }
  }
}
