/**
 * **R5**: turning the artist tag on a track into a MusicBrainz identity, or
 * honestly failing to.
 *
 * The four files split along the line the risk itself draws. `artistName`
 * handles the tag strings that break naive lookup; `search` handles the service;
 * `score` handles the decision, which is the part that can be wrong in a way an
 * operator would believe; `store` handles the column that makes the decision
 * once. `service` is the only one that knows about all four.
 *
 * W7-11 adds a second thing this identity is *for*, on the same three
 * ingredients: `relations` fetches the artist document, `libraryArtists` joins it
 * back to the local `artists` table, and `relationsService` is the only one that
 * knows about both. It is downstream of the resolver in the strict sense — it
 * reads the MBID the resolver wrote and never searches by name — which is what
 * keeps the deck from ever showing one artist's members under another's name.
 *
 * Nothing here reaches for a socket directly — it takes a `NetClient` and a
 * `CacheService`, which is what puts consent (**D14**), the one-request-per-second
 * ceiling and the negative cache in front of every request without this module
 * restating any of them.
 */

export { compareKey, escapeLucene, searchCacheKey, searchQuery } from './artistName'
export {
  createLibraryArtistLookup,
  type ArtistLookupKey,
  type LibraryArtistLookup,
  type LibraryArtistRow,
  type MatchedLibraryArtist
} from './libraryArtists'
export {
  ARTIST_RELATIONS_INC,
  artistRelationsUrl,
  fetchArtistRelations,
  parseArtistRelations,
  relationKind,
  relationsCacheKey,
  type ParsedRelation
} from './relations'
export {
  createArtistRelationsService,
  intersectRelations,
  type ArtistRelationsService,
  type ArtistRelationsServiceOptions
} from './relationsService'
export {
  ARTIST_URL_RELATIONS_INC,
  artistUrlRelationsUrl,
  fetchArtistUrlRelations,
  linkCategory,
  parseArtistUrlRelations,
  urlRelationsCacheKey
} from './urlRelations'
export {
  createArtistLinksService,
  limitLinks,
  type ArtistLinksService,
  type ArtistLinksServiceOptions
} from './urlRelationsService'
export {
  CORROBORATION_ALBUM_LIMIT,
  parseReleaseGroupSearch,
  releaseGroupCacheKey,
  releaseGroupQuery,
  releaseGroupSearchUrl,
  searchReleaseGroups,
  type CreditedReleaseGroup
} from './releaseGroups'
export {
  ARTIST_MATCH_MARGIN,
  ARTIST_MATCH_THRESHOLD,
  CORROBORATION_TITLE_THRESHOLD,
  NAME_WEIGHT,
  combinedScore,
  corroborate,
  countCorroboration,
  decide,
  nameScore,
  similarity,
  type MatchDecision,
  type ScoredCandidate
} from './score'
export {
  MUSICBRAINZ_WS,
  artistSearchUrl,
  parseArtistSearch,
  searchArtists,
  type SearchedArtist
} from './search'
export {
  createArtistIdentityService,
  rankCandidates,
  type ArtistIdentityService,
  type ArtistIdentityServiceOptions
} from './service'
export { createArtistIdentityStore, type ArtistIdentityStore, type StoredIdentity } from './store'
