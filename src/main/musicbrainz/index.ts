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
 * Nothing here reaches for a socket directly — it takes a `NetClient` and a
 * `CacheService`, which is what puts consent (**D14**), the one-request-per-second
 * ceiling and the negative cache in front of every request without this module
 * restating any of them.
 */

export { compareKey, escapeLucene, searchCacheKey, searchQuery } from './artistName'
export {
  ARTIST_MATCH_MARGIN,
  ARTIST_MATCH_THRESHOLD,
  NAME_WEIGHT,
  combinedScore,
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
