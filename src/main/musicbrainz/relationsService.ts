/**
 * Relations, assembled: the row, one lookup, the cache and the library join.
 *
 * ## Where the MBID comes from
 *
 * The `artists` row, never the request — `wikipedia/service.ts`' rule, and for
 * the same two reasons. A correction made in the picker changes which artist's
 * relations load without this layer knowing the picker exists, and a renderer
 * holding a stale resolution cannot pull the relation graph of an artist the
 * operator has already overruled. That last part is this card's third acceptance
 * criterion stated as an invariant rather than as a guard: an unresolved artist
 * is answered `none` before anything is fetched, so there is no path by which a
 * relation graph for the wrong band reaches the deck.
 *
 * ## One document, two answers
 *
 * The MusicBrainz half is cached and the library half is not, which is the whole
 * shape of this service. Relations are curated edits and move on a scale of
 * months, so the document gets thirty days; ownership moves whenever a folder is
 * scanned, so the intersection is recomputed on every call from the cached
 * document. A cache of the *joined* result would be wrong within a minute of the
 * next import and would be wrong in the most visible way — a pane saying you own
 * nothing by a band whose albums you just added.
 *
 * ## Every failure is a state
 *
 * Nothing here throws for a network reason, for `service.ts`' reason. A
 * `NetResult` comes in and an `ArtistRelationsResult` goes out; the only
 * exceptions are database errors, which are bugs and belong at the IPC layer's
 * `internal`.
 */

import {
  ARTIST_RELATION_LIMIT,
  type ArtistRelation,
  type ArtistRelationKind,
  type ArtistRelationsResult
} from '@shared/artistRelations'
import type { NetFailure } from '@shared/net'
import type Database from 'better-sqlite3'
import type { CacheService } from '../cache'
import type { NetClient } from '../net'
import { createLibraryArtistLookup, type LibraryArtistLookup } from './libraryArtists'
import { fetchArtistRelations, relationsCacheKey, type ParsedRelation } from './relations'
import { createArtistIdentityStore } from './store'

const ARTIST_ENTITY = 'musicbrainz.artist' as const

export interface ArtistRelationsService {
  /** The relations for a library artist. Never throws for a missing artist page. */
  get(artistId: number): Promise<ArtistRelationsResult>
}

export interface ArtistRelationsServiceOptions {
  db: Database.Database
  client: NetClient
  cache: CacheService
}

/**
 * The order the kinds are drawn in, and therefore the order truncation keeps.
 *
 * Membership first because it is the question the pane is opened for — it is
 * what the group is named after — and the two directions adjacent because they
 * are one relationship. The rest descend by how far they are from that
 * question: a side project is a band by another name, a collaboration is a
 * looser one, and an alias is not another act at all.
 */
const KIND_ORDER: Readonly<Record<ArtistRelationKind, number>> = {
  member: 0,
  group: 1,
  'side-project': 2,
  collaboration: 3,
  alias: 4
}

/**
 * Sorts the relations into the order the pane draws and the cap trims.
 *
 * Four keys, in this order and not another. Kind groups the list into the
 * headings. `ended` puts current connections above finished ones inside a
 * heading, because "who is in this band" is asked more often than "who used to
 * be". Ownership comes third and is the reason the cap is safe: an owned artist
 * cannot be trimmed away while an unowned one survives in the same section,
 * which is precisely the row the operator opened this pane to find. The name is
 * the last tiebreak and exists so the order does not depend on how MusicBrainz
 * happened to serialise its document — a list that reshuffles between two
 * lookups of the same artist reads as a bug even when both orders are defensible.
 */
function compareRelations(a: ArtistRelation, b: ArtistRelation): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    Number(a.ended) - Number(b.ended) ||
    Number(b.match !== null) - Number(a.match !== null) ||
    a.name.localeCompare(b.name)
  )
}

/** No relations, for any of the several ordinary reasons. */
function none(artistId: number): ArtistRelationsResult {
  return { artistId, status: 'none', relations: [], truncated: false, failure: null }
}

/** A failure the pane should show as a failure rather than as an empty state. */
function unavailable(artistId: number, failure: NetFailure): ArtistRelationsResult {
  return { artistId, status: 'unavailable', relations: [], truncated: false, failure }
}

/**
 * Joins the parsed relations to the library and orders the result.
 *
 * Exported because it is the half worth testing without a socket: every
 * interesting case in this card — the MBID join, the name fallback, the
 * contradicted name match, ownership surviving truncation — is a property of
 * this function and of `createLibraryArtistLookup` beneath it.
 */
export function intersectRelations(
  artistId: number,
  parsed: readonly ParsedRelation[],
  lookup: LibraryArtistLookup
): ArtistRelationsResult {
  if (parsed.length === 0) return none(artistId)

  const matches = lookup.match(parsed.map(({ mbid, name }) => ({ mbid, name })))

  const relations: ArtistRelation[] = parsed.map((relation) => {
    const row = matches.get(relation.mbid)
    return {
      ...relation,
      match:
        row === undefined
          ? null
          : {
              artistId: row.artistId,
              name: row.name,
              trackCount: row.trackCount,
              basis: row.basis
            }
    }
  })

  relations.sort(compareRelations)

  return {
    artistId,
    status: 'ready',
    relations: relations.slice(0, ARTIST_RELATION_LIMIT),
    truncated: relations.length > ARTIST_RELATION_LIMIT,
    failure: null
  }
}

export function createArtistRelationsService({
  db,
  client,
  cache
}: ArtistRelationsServiceOptions): ArtistRelationsService {
  const identities = createArtistIdentityStore(db)
  const lookup = createLibraryArtistLookup(db)

  return {
    async get(artistId): Promise<ArtistRelationsResult> {
      const identity = identities.byId(artistId)
      // The artist left the library while the deck was looking at it, or was
      // never resolved. Both are `none` rather than a throw, and the second is
      // the one that matters: no MBID means no lookup, which means there is no
      // way for this pane to show somebody else's band.
      if (!identity?.mbid) return none(artistId)
      const mbid = identity.mbid

      const result = await cache.through(ARTIST_ENTITY, relationsCacheKey(mbid), () =>
        fetchArtistRelations(client, mbid)
      )

      if (!result.ok) {
        // A merged-away identifier answers 404. That is a fact about the artist
        // rather than a fault, it is already in the negative cache, and the
        // header above this pane is where the operator fixes it — so it reads
        // as an empty state and not as a retry.
        if (result.failure.kind === 'not-found') return none(artistId)
        return unavailable(artistId, result.failure)
      }

      return intersectRelations(artistId, result.value, lookup)
    }
  }
}
