/**
 * Outbound links, assembled: the pane, one lookup and the cache.
 *
 * The lighter sibling of `relationsService.ts`. It shares that service's spine —
 * the MBID comes off the `artists` row and never off the request, the document
 * is cached and every network failure is a state rather than a throw — but not
 * its second half: there is no library to intersect a homepage against, so the
 * parsed links are the answer and no join follows.
 *
 * ## Where the MBID comes from
 *
 * The `artists` row, never the request — `wikipedia/service.ts`' rule and
 * `relationsService.ts`' rule, for the same reason both state it. An unresolved
 * artist is answered `none` before anything is fetched, so there is no path by
 * which one artist's links reach a deck that is showing another. It matters a
 * shade more here than for the biography: these links open a browser, and the
 * failure being guarded against is not a wrong sentence but the wrong front door.
 *
 * ## Every failure is a state
 *
 * Nothing here throws for a network reason. A `NetResult` comes in and an
 * `ArtistLinksResult` goes out; the only exceptions are database errors, which
 * are bugs and belong at the IPC layer's `internal`.
 */

import { ARTIST_LINK_LIMIT, type ArtistLink, type ArtistLinksResult } from '@shared/artistLinks'
import type { NetFailure } from '@shared/net'
import type Database from 'better-sqlite3'
import type { CacheService } from '../cache'
import type { NetClient } from '../net'
import { createArtistIdentityStore } from './store'
import { fetchArtistUrlRelations, urlRelationsCacheKey } from './urlRelations'

// The same cache entity `relationsService.ts` uses, and deliberately so: it is
// one MusicBrainz artist document, and the two `inc`s are separated by the key
// rather than by the entity so both expire on the artist-document TTL.
const ARTIST_ENTITY = 'musicbrainz.artist' as const

export interface ArtistLinksService {
  /** The outbound links for a library artist. Never throws for a missing artist page. */
  get(artistId: number): Promise<ArtistLinksResult>
}

export interface ArtistLinksServiceOptions {
  db: Database.Database
  client: NetClient
  cache: CacheService
}

/** No links, for any of the several ordinary reasons. */
function none(artistId: number): ArtistLinksResult {
  return { artistId, status: 'none', links: [], truncated: false, failure: null }
}

/** A failure the pane should show as a failure rather than as an empty state. */
function unavailable(artistId: number, failure: NetFailure): ArtistLinksResult {
  return { artistId, status: 'unavailable', links: [], truncated: false, failure }
}

/**
 * Caps the parsed links and reports whether it had to.
 *
 * The parse already sorted by category and then URL, so the cap trims from the
 * tail — the alphabetically-late socials — and never the homepage. Exported for
 * `intersectRelations`' reason: the truncation is a property worth asserting
 * without a socket.
 */
export function limitLinks(artistId: number, parsed: readonly ArtistLink[]): ArtistLinksResult {
  if (parsed.length === 0) return none(artistId)
  return {
    artistId,
    status: 'ready',
    links: parsed.slice(0, ARTIST_LINK_LIMIT),
    truncated: parsed.length > ARTIST_LINK_LIMIT,
    failure: null
  }
}

export function createArtistLinksService({
  db,
  client,
  cache
}: ArtistLinksServiceOptions): ArtistLinksService {
  const identities = createArtistIdentityStore(db)

  return {
    async get(artistId): Promise<ArtistLinksResult> {
      const identity = identities.byId(artistId)
      // The artist left the library while the deck was looking at it, or was
      // never resolved. Both are `none` rather than a throw, and the second is
      // the one that matters: no MBID means no lookup, which means no chance of
      // opening the wrong artist's homepage.
      if (!identity?.mbid) return none(artistId)
      const mbid = identity.mbid

      const result = await cache.through(ARTIST_ENTITY, urlRelationsCacheKey(mbid), () =>
        fetchArtistUrlRelations(client, mbid)
      )

      if (!result.ok) {
        // A merged-away identifier answers 404 — a fact about the artist rather
        // than a fault, already in the negative cache, fixed at the header above
        // the pane. It reads as an empty state and not as a retry.
        if (result.failure.kind === 'not-found') return none(artistId)
        return unavailable(artistId, result.failure)
      }

      return limitLinks(artistId, result.value)
    }
  }
}
