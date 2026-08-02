/**
 * Artist identity, assembled: the row, the search, the cache and the verdict.
 *
 * ## Once per artist, not once per play
 *
 * The card's second bullet is a performance claim disguised as a schema change —
 * "a match is made once per artist rather than once per play" — and it is only
 * true if this service *acts* on the column it added. So `resolve` searches only
 * when the row carries no decision at all. An artist matched last Tuesday is
 * answered from two columns and no socket, whoever is playing and however often
 * the deck reopens.
 *
 * That leaves the picker without a list to show, which is what
 * `searchCandidates` is for: the search happens when the operator asks to see
 * the alternatives, rather than on every play against the chance that they
 * might. Candidates already in `cache.db` are handed over for free either way,
 * because reading a row we have opens no socket — the same reasoning
 * `cache/service.ts` gives for answering a fresh entry with lookups switched off.
 *
 * ## Every failure is a state
 *
 * Nothing here throws for a network reason. `NetResult` comes in and an
 * `ArtistResolution` goes out, and "MusicBrainz is down" arrives at the deck as
 * `unavailable` with a sentence attached rather than as a rejected promise. The
 * exceptions this can still raise are database errors, which are bugs and belong
 * at the IPC layer's `internal`.
 */

import {
  type ArtistCandidate,
  type ArtistResolution,
  type ArtistResolutionStatus,
  isMbid
} from '@shared/artist'
import { FermataError } from '@shared/errors'
import type { NetFailure } from '@shared/net'
import type Database from 'better-sqlite3'
import type { CacheService } from '../cache'
import type { NetClient } from '../net'
import { searchCacheKey, searchQuery } from './artistName'
import {
  CORROBORATION_ALBUM_LIMIT,
  releaseGroupCacheKey,
  searchReleaseGroups,
  type CreditedReleaseGroup
} from './releaseGroups'
import {
  combinedScore,
  corroborate,
  countCorroboration,
  decide,
  nameScore,
  type ScoredCandidate
} from './score'
import { searchArtists, type SearchedArtist } from './search'
import { createArtistIdentityStore, type StoredIdentity } from './store'

const SEARCH_ENTITY = 'musicbrainz.artist-search' as const
const RELEASE_GROUP_ENTITY = 'musicbrainz.release-group' as const

export interface ArtistIdentityService {
  /** What the deck shows for whatever is playing. `null` when the track has no artist. */
  resolve(trackId: number): Promise<ArtistResolution | null>
  /** The picker's list. Searches even when the identity is already settled. */
  searchCandidates(artistId: number): Promise<ArtistResolution>
  /** The operator's choice. `null` means "none of these", and is durable. */
  setMbid(artistId: number, mbid: string | null): Promise<ArtistResolution>
  /** Forgets the correction and matches automatically again. */
  clearMbid(artistId: number): Promise<ArtistResolution>
}

export interface ArtistIdentityServiceOptions {
  db: Database.Database
  client: NetClient
  cache: CacheService
}

/** Ranks a search reply against the name we searched for, best first. */
export function rankCandidates(
  query: string,
  artists: readonly SearchedArtist[]
): ScoredCandidate[] {
  const scored = artists.map((artist): ScoredCandidate => {
    const name = nameScore(query, {
      name: artist.name,
      sortName: artist.sortName,
      aliases: artist.aliases
    })
    return {
      mbid: artist.mbid,
      name: artist.name,
      sortName: artist.sortName,
      disambiguation: artist.disambiguation,
      country: artist.country,
      type: artist.type,
      begin: artist.begin,
      end: artist.end,
      nameScore: name,
      searchScore: artist.searchScore,
      score: combinedScore(name, artist.searchScore)
    }
  })

  // Sorted on the combined score, then on MusicBrainz's, then on the name. The
  // last tiebreak is not cosmetic: `decide` compares the top two, so a sort that
  // reorders equal candidates between runs would make the verdict depend on the
  // service's array order. It is ambiguous either way — but it has to be
  // ambiguous *consistently*, or the same artist resolves differently on two
  // machines.
  scored.sort(
    (a, b) => b.score - a.score || b.searchScore - a.searchScore || a.name.localeCompare(b.name)
  )
  return scored
}

/** Drops the scoring internals. The contract promises one number, not three. */
function toCandidate(scored: ScoredCandidate): ArtistCandidate {
  const { nameScore: _name, searchScore: _search, ...candidate } = scored
  return candidate
}

export function createArtistIdentityService({
  db,
  client,
  cache
}: ArtistIdentityServiceOptions): ArtistIdentityService {
  const store = createArtistIdentityStore(db)

  /**
   * The status a settled row reports.
   *
   * A manual `null` is the operator having answered "none of these", and it
   * reports as `no-match` — the same status as MusicBrainz having nothing,
   * because it is the same fact about the world. `source` is what tells the two
   * apart, and the deck words the line differently for each.
   */
  function settledStatus(identity: StoredIdentity): ArtistResolutionStatus {
    return identity.mbid === null ? 'no-match' : 'resolved'
  }

  function build(
    identity: StoredIdentity,
    query: string,
    status: ArtistResolutionStatus,
    candidates: readonly ScoredCandidate[],
    failure: NetFailure | null
  ): ArtistResolution {
    return {
      artistId: identity.artistId,
      name: identity.name,
      query,
      status,
      mbid: identity.mbid,
      source: identity.source,
      candidates: candidates.map(toCandidate),
      failure
    }
  }

  /** Candidates we already hold, fresh or stale. Never opens a socket. */
  function cachedCandidates(query: string): ScoredCandidate[] {
    const entry = cache.read<SearchedArtist[]>(SEARCH_ENTITY, searchCacheKey(query))
    if (!entry?.value) return []
    return rankCandidates(query, entry.value)
  }

  /** Candidates from the cache, falling back to a request. */
  async function fetchCandidates(
    query: string
  ): Promise<{ candidates: ScoredCandidate[]; failure: NetFailure | null }> {
    const result = await cache.through(SEARCH_ENTITY, searchCacheKey(query), () =>
      searchArtists(client, query)
    )
    if (!result.ok) return { candidates: [], failure: result.failure }
    return { candidates: rankCandidates(query, result.value), failure: null }
  }

  function requireIdentity(artistId: number): StoredIdentity {
    const identity = store.byId(artistId)
    if (!identity) {
      throw new FermataError('not-found', 'That artist is no longer in the library.')
    }
    return identity
  }

  /**
   * The second opinion, asked for only when the first one tied.
   *
   * One request, and it is the only place in the resolver that reads the
   * *library* rather than a name — which is the whole reason it can settle what
   * the name could not. An artist with no albums to offer is answered without a
   * request at all: there is nothing to corroborate with, and a release-group
   * search for an empty title list matches everything.
   */
  async function corroborateVerdict(
    identity: StoredIdentity,
    query: string,
    candidates: readonly ScoredCandidate[]
  ): Promise<ReturnType<typeof decide>> {
    const albums = store.albumTitles(identity.artistId, CORROBORATION_ALBUM_LIMIT)
    if (albums.length === 0) return { kind: 'ambiguous' }

    const result = await cache.through<CreditedReleaseGroup[]>(
      RELEASE_GROUP_ENTITY,
      releaseGroupCacheKey(query, albums),
      () => searchReleaseGroups(client, query, albums)
    )
    // Any failure leaves the verdict where it was. `not-found` means MusicBrainz
    // credits none of our albums to anybody matching this name, and a network
    // failure means we did not get to ask — both are "still ambiguous", which is
    // the state with a picker attached.
    if (!result.ok) return { kind: 'ambiguous' }

    return corroborate(candidates, countCorroboration(albums, result.value))
  }

  /**
   * The unsettled path: search, score, and write the verdict back when it is
   * confident enough to be worth keeping.
   */
  async function resolveFresh(identity: StoredIdentity, query: string): Promise<ArtistResolution> {
    const { candidates, failure } = await fetchCandidates(query)

    if (failure) {
      // `not-found` is an answer rather than a failure — the service looked and
      // has nothing — and the cache has already remembered it for a week.
      const status: ArtistResolutionStatus =
        failure.kind === 'not-found' ? 'no-match' : 'unavailable'
      return build(identity, query, status, [], status === 'unavailable' ? failure : null)
    }

    // Ambiguity is the only verdict worth a second request. `none` has nothing
    // above the threshold for corroboration to promote, and `accept` is settled.
    let verdict = decide(candidates)
    if (verdict.kind === 'ambiguous') {
      verdict = await corroborateVerdict(identity, query, candidates)
    }

    if (verdict.kind !== 'accept') {
      return build(
        identity,
        query,
        verdict.kind === 'none' ? 'no-match' : 'ambiguous',
        candidates,
        null
      )
    }

    // The statement refuses to overwrite a manual choice, so a correction made
    // while this search was in flight wins the race without a lock.
    const written = store.promote(identity.artistId, verdict.match.mbid)
    const settled = written ? requireIdentity(identity.artistId) : identity
    return build(settled, query, settledStatus(settled), candidates, null)
  }

  return {
    async resolve(trackId): Promise<ArtistResolution | null> {
      const identity = store.forTrack(trackId)
      if (!identity) return null

      const query = searchQuery(identity.name)
      if (identity.source !== null) {
        return build(identity, query, settledStatus(identity), cachedCandidates(query), null)
      }
      return resolveFresh(identity, query)
    },

    async searchCandidates(artistId): Promise<ArtistResolution> {
      const identity = requireIdentity(artistId)
      const query = searchQuery(identity.name)

      // A settled row keeps the identity it has, whatever the list says. That is
      // the "adopts nothing" rule, and its scope is exactly this: the operator
      // opened the picker to disagree with a decision, and re-deciding it
      // underneath them would be the deck arguing with itself.
      //
      // An *unsettled* row has no decision to protect, so it takes the ordinary
      // path — including promoting a match, which is not overwriting anything.
      // Sharing `resolveFresh` here is also what stops the header describing the
      // artist one way and the picker another.
      if (identity.source === null) return resolveFresh(identity, query)

      const { candidates, failure } = await fetchCandidates(query)
      if (failure && failure.kind !== 'not-found') {
        return build(identity, query, 'unavailable', [], failure)
      }
      return build(identity, query, settledStatus(identity), candidates, null)
    },

    async setMbid(artistId, mbid): Promise<ArtistResolution> {
      if (mbid !== null && !isMbid(mbid)) {
        throw new FermataError('invalid-request', 'That is not a MusicBrainz identifier.')
      }
      const existing = requireIdentity(artistId)
      store.setManual(artistId, mbid)

      const identity = requireIdentity(artistId)
      const query = searchQuery(existing.name)
      // No fetch: the operator picked from a list that was on screen, which
      // means it is in the cache, which means this is a read.
      return build(identity, query, settledStatus(identity), cachedCandidates(query), null)
    },

    async clearMbid(artistId): Promise<ArtistResolution> {
      const existing = requireIdentity(artistId)
      store.clear(artistId)

      // Resolving rather than answering "nothing known": clearing a correction
      // means "match this automatically again", and returning an empty identity
      // would leave the deck blank until something else happened to ask.
      const identity = requireIdentity(artistId)
      return resolveFresh(identity, searchQuery(existing.name))
    }
  }
}
