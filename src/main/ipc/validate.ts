import {
  isMbid,
  type ClearArtistMbidRequest,
  type ResolveArtistQuery,
  type SearchArtistCandidatesRequest,
  type SetArtistMbidRequest
} from '@shared/artist'
import type { GetArtistRelationsRequest } from '@shared/artistRelations'
import type { GetArtistBiographyRequest } from '@shared/biography'
import type { GetArtistImageRequest } from '@shared/artistImage'
import { OscineError } from '@shared/errors'
import {
  MAX_FAVORITE_IDS_PAGE,
  MAX_FAVORITE_REMOVE_IDS,
  MAX_FAVORITE_STATE_IDS,
  MAX_FAVORITES_PAGE,
  type ArtistFavoriteStateRequest,
  type ArtistFavoritesQuery,
  type FavoriteStateRequest,
  type ListFavoriteArtistsQuery,
  type ListFavoriteIdsQuery,
  type ListFavoritePlaylistsQuery,
  type ListFavoritesQuery,
  type PlaylistFavoriteStateRequest,
  type RemoveFavoritesRequest,
  type ToggleArtistFavoriteRequest,
  type TogglePlaylistFavoriteRequest,
  type ToggleFavoriteRequest
} from '@shared/favorites'
import { PLAY_HISTORY_CAP, type ListPlayHistoryQuery } from '@shared/history'
import type { RecordListenRequest } from '@shared/listens'
import {
  MAX_STATS_BUCKETS,
  MAX_STATS_ROWS,
  STATS_BUCKET_MS,
  STATS_BUCKETS,
  STATS_DIMENSIONS,
  STATS_SCOPE_BYS,
  STATS_SORTS,
  type StatsBucket,
  type StatsDimension,
  type StatsOverTimeQuery,
  type StatsQuery,
  type StatsRange,
  type StatsScope,
  type StatsScopeBy,
  type StatsSort,
  type StatsSummaryQuery
} from '@shared/stats'
import { NET_SCOPES, type CancelNetScopeRequest, type NetScope } from '@shared/net'
import {
  SCROBBLE_TARGET_IDS,
  type ScrobbleTargetId,
  type ScrobbleTargetRequest
} from '@shared/scrobble'
import { PODCAST_BROWSE_CATEGORIES } from '@shared/podcasts'
import {
  parseSettingsProfile,
  SETTING_SCOPE_KINDS,
  SETTINGS_IMPORT_MODES,
  type GetSettingOverridesRequest,
  type ImportSettingsProfileRequest,
  type ResetSettingsRequest,
  type SetSettingRequest,
  type SettingScopeKind,
  type SettingScopeRef,
  type SettingsImportMode
} from '@shared/settings'
import {
  type GetTracksByIdsQuery,
  type LibraryBrowseFilters,
  type ListFacetIdsQuery,
  type ListFacetsQuery,
  type ListTrackGroupsQuery,
  type ListTrackIdsQuery,
  type ListTracksQuery,
  MAX_FACET_ID_PAGE,
  MAX_FACET_PAGE,
  MAX_FILTER_IDS,
  MAX_ORDERED_TRACK_IDS,
  MAX_SEARCH_LENGTH,
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE,
  MIN_SEARCH_LENGTH,
  type OrderTrackIdsQuery,
  type SortDirection,
  TRACK_SORT_COLUMNS,
  type TrackSortColumn
} from '@shared/library'
import type { RelatedQuery } from '@shared/related'
import { MAX_SEARCH_LIMIT_PER_GROUP, type SearchMode, type SearchQuery } from '@shared/search'
import { MAX_RECENT_ALBUMS } from '@shared/albums'
import {
  DISCOVER_RECIPE_IDS,
  type DiscoverRecipeId,
  type SaveDiscoverShelfRequest
} from '@shared/discover'
import {
  MAX_PLAYLIST_BATCH,
  MAX_PLAYLIST_ENTRY_ID_PAGE,
  MAX_PLAYLIST_ENTRY_PAGE,
  MAX_PLAYLIST_NAME_LENGTH,
  PLAYLIST_PATH_STYLES,
  type AddTracksToPlaylistRequest,
  type ExportPlaylistRequest,
  type ListPlaylistEntriesQuery,
  type ListPlaylistEntryGroupsQuery,
  type ListPlaylistEntryIdsQuery,
  type PlaylistEntryOrder,
  type MovePlaylistEntriesRequest,
  type PlaylistInsertion,
  type PlaylistPathStyle,
  type RemovePlaylistEntriesRequest
} from '@shared/playlists'

/**
 * Request validation at the boundary.
 *
 * The renderer is our own code, so this is not primarily about a hostile
 * caller — it is about the two failure modes that actually happen: a bug
 * sending the wrong shape, and a compromised renderer probing the seam. Both
 * are cheaper to catch here than in a SQL query three layers down.
 */

function invalid(message: string): never {
  throw new OscineError('invalid-request', message)
}

function assertOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(raw).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) invalid(`Unexpected query field: ${unexpected[0]}.`)
}

export function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    invalid(`${field} must be a positive integer.`)
  }
  return value
}

export function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${field} must be an object.`)
  }
  return value as Record<string, unknown>
}

/**
 * A facet dimension: a non-empty, deduplicated set of positive ids.
 *
 * Empty is rejected rather than normalised to "no constraint". An empty array
 * reaching here means a caller cleared a selection and kept the field, and the
 * two readings of that — match nothing, match everything — differ by the whole
 * library. Better a loud `invalid-request` at the seam than the wrong one.
 *
 * Duplicates are dropped rather than refused: they change no result, and a
 * selection assembled from overlapping ranges can honestly contain them.
 */
function assertIdSet(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array of positive integers.`)
  if (value.length === 0) invalid(`${field} must not be empty.`)
  if (value.length > MAX_FILTER_IDS) invalid(`${field} must not exceed ${MAX_FILTER_IDS} ids.`)
  return [...new Set(value.map((id) => assertPositiveInt(id, `${field} entries`)))]
}

function assertBrowseFilters(raw: Record<string, unknown>): LibraryBrowseFilters {
  const filters: LibraryBrowseFilters = {}
  if (raw.rootId !== undefined) filters.rootId = assertPositiveInt(raw.rootId, 'rootId')
  for (const field of ['artistIds', 'albumIds'] as const) {
    if (raw[field] !== undefined) filters[field] = assertIdSet(raw[field], field)
  }

  if (raw.searchText !== undefined) {
    if (typeof raw.searchText !== 'string') invalid('searchText must be a string.')
    const searchText = raw.searchText.trim()
    const searchable = searchText
      .split(/\s+/u)
      .some((term) => [...term].length >= MIN_SEARCH_LENGTH)
    if (!searchable) {
      invalid(`searchText must contain a term of at least ${MIN_SEARCH_LENGTH} characters.`)
    }
    if ([...searchText].length > MAX_SEARCH_LENGTH) {
      invalid(`searchText must not exceed ${MAX_SEARCH_LENGTH} characters.`)
    }
    filters.searchText = searchText
  }
  return filters
}

function assertWindow(
  raw: Record<string, unknown>,
  maxPage: number
): Pick<ListFacetsQuery, 'offset' | 'limit'> {
  const offset = raw.offset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    invalid('offset must be a non-negative integer.')
  }

  const limit = raw.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    invalid('limit must be a positive integer.')
  }
  if (limit > maxPage) invalid(`limit must not exceed ${maxPage}.`)
  return { offset, limit }
}

const FACET_QUERY_KEYS = [
  'rootId',
  'artistIds',
  'albumIds',
  'searchText',
  'offset',
  'limit'
] as const

export function assertListFacetsQuery(value: unknown): ListFacetsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, FACET_QUERY_KEYS)
  return { ...assertBrowseFilters(raw), ...assertWindow(raw, MAX_FACET_PAGE) }
}

/**
 * Same shape as a facet query, larger page ceiling — the id-page argument again,
 * one dimension over. The ceiling equals `MAX_FILTER_IDS` so that a range wide
 * enough to become a filter is always resolvable in a single call.
 */
export function assertListFacetIdsQuery(value: unknown): ListFacetIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, FACET_QUERY_KEYS)
  return { ...assertBrowseFilters(raw), ...assertWindow(raw, MAX_FACET_ID_PAGE) }
}

/**
 * Validates the ordering half of a track query.
 *
 * `sort` and `direction` are checked against closed allowlists rather than
 * merely typed, because both are interpolated into an ORDER BY clause in W2-1.
 * A type annotation is erased at runtime; this check is not.
 */
function assertOrdering(raw: Record<string, unknown>): {
  sort: TrackSortColumn
  direction: SortDirection
} {
  const sort = raw.sort
  if (typeof sort !== 'string' || !TRACK_SORT_COLUMNS.includes(sort as never)) {
    invalid(`sort must be one of: ${TRACK_SORT_COLUMNS.join(', ')}.`)
  }

  const direction = raw.direction
  if (direction !== 'asc' && direction !== 'desc') {
    invalid("direction must be 'asc' or 'desc'.")
  }

  return { sort: sort as TrackSortColumn, direction }
}

const TRACK_QUERY_KEYS = [
  'rootId',
  'artistIds',
  'albumIds',
  'searchText',
  'sort',
  'direction',
  'offset',
  'limit'
] as const

export function assertListTracksQuery(value: unknown): ListTracksQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, TRACK_QUERY_KEYS)
  return {
    ...assertBrowseFilters(raw),
    ...assertOrdering(raw),
    ...assertWindow(raw, MAX_TRACK_PAGE)
  }
}

/**
 * Same shape as a track query, larger page ceiling.
 *
 * The ceiling is the only difference and it is the whole point of the separate
 * channel: an id page carries integers rather than the display projection, so a
 * range selection can resolve ten thousand rows in one call without either side
 * pretending that is the same cost as ten thousand `Track` objects.
 */
export function assertListTrackIdsQuery(value: unknown): ListTrackIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, TRACK_QUERY_KEYS)
  return {
    ...assertBrowseFilters(raw),
    ...assertOrdering(raw),
    ...assertWindow(raw, MAX_TRACK_ID_PAGE)
  }
}

/**
 * Validates a request for the album runs behind a grouped list.
 *
 * Unpaged, so it carries the ordering and the filters but no window — the
 * renderer needs every run to size the list before it loads a row. The sort
 * column is validated the same way as any other list request; the store is what
 * rejects a non-album-major one, since that is a contract about the shape of
 * the list rather than about the shape of the message.
 */
export function assertListTrackGroupsQuery(value: unknown): ListTrackGroupsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['rootId', 'artistIds', 'albumIds', 'searchText', 'sort', 'direction'])
  return {
    ...assertBrowseFilters(raw),
    ...assertOrdering(raw)
  }
}

/**
 * Validates a request to widen an id list into display rows.
 *
 * Every element is checked rather than sampled, for the reason the sibling
 * below gives: these ids reach SQLite through `json_each`, where one
 * non-integer is a short result rather than an error.
 */
export function assertGetTracksByIdsQuery(value: unknown): GetTracksByIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['ids'])

  const ids = raw.ids
  if (!Array.isArray(ids)) invalid('ids must be an array.')
  // `MAX_TRACK_PAGE`, not `MAX_ORDERED_TRACK_IDS`: this response carries display
  // rows rather than bare integers, so the ceiling is the one every other
  // row-returning request is held to. A caller queueing a large selection
  // chunks against it.
  if (ids.length > MAX_TRACK_PAGE) {
    invalid(`ids must not exceed ${MAX_TRACK_PAGE} entries.`)
  }
  for (const id of ids) assertPositiveInt(id, 'ids entry')

  return { ids: ids as number[] }
}

/**
 * D18's requests.
 *
 * `assertOnlyKeys` on all of them, like every other query here: a request
 * carrying a field this build does not know about is one written against a
 * different contract, and accepting it silently is how the two stop matching.
 */
export function assertToggleFavoriteRequest(value: unknown): ToggleFavoriteRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['trackId'])
  return { trackId: assertPositiveInt(raw.trackId, 'trackId') }
}

/**
 * A batch state lookup, held to `listTrackIds`' ceiling rather than a new one.
 *
 * The response is one integer per *favorited* id — sparser than the request, and
 * bounded by it — so the ceiling is about how much work the query is asked to do
 * rather than about how large the answer can get. That work is one indexed probe
 * per id, which is why the number can be this high at all.
 */
export function assertFavoriteStateRequest(value: unknown): FavoriteStateRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['trackIds'])

  const trackIds = raw.trackIds
  if (!Array.isArray(trackIds)) invalid('trackIds must be an array.')
  if (trackIds.length > MAX_FAVORITE_STATE_IDS) {
    invalid(`trackIds must not exceed ${MAX_FAVORITE_STATE_IDS} entries.`)
  }
  for (const id of trackIds) assertPositiveInt(id, 'trackIds entry')

  return { trackIds: trackIds as number[] }
}

/**
 * The rail's window. A window and nothing else — no sort, no filters.
 *
 * D18 gives this collection one order, and a `sort` parameter here would be an
 * ordering the store has no column to express. The ceiling is `listTracks`', because
 * the response is display rows.
 */
export function assertListFavoritesQuery(value: unknown): ListFavoritesQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['offset', 'limit'])
  return assertWindow(raw, MAX_FAVORITES_PAGE)
}

/**
 * The same window, ids only, held to `listTrackIds`' ceiling.
 *
 * An order of magnitude above the display page for the reason that one is: the
 * response is a flat array of integers, so a ten-thousand-row Shift-range
 * resolves in one round trip rather than ten.
 */
export function assertListFavoriteIdsQuery(value: unknown): ListFavoriteIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['offset', 'limit'])
  return assertWindow(raw, MAX_FAVORITE_IDS_PAGE)
}

/**
 * The deck's Favorite Songs read. A seed track, and nothing else to get wrong.
 *
 * A `trackId` and not an `artistId`, which is the contract's decision rather
 * than this function's — see the channel's note. What belongs here is that
 * there is no second field: `ARTIST_FAVORITES_LIMIT` is the pane's own cap and
 * not a window the caller chooses, so a `limit` would let a renderer ask for a
 * page the pane has no way to draw, and would make the one number `truncated` is
 * computed against something the sender could disagree with.
 */
export function assertArtistFavoritesQuery(value: unknown): ArtistFavoritesQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['trackId'])
  return { trackId: assertPositiveInt(raw.trackId, 'trackId') }
}

/**
 * The batch removal, bounded like the batch state lookup.
 *
 * Same ceiling and same shape, because the two take the same kind of argument
 * from the same kind of caller — a selection resolved through `favorites.listIds`
 * — and a smaller number here would make a selection that could legally be
 * *asked about* one that could not legally be removed.
 */
export function assertRemoveFavoritesRequest(value: unknown): RemoveFavoritesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['trackIds'])

  const trackIds = raw.trackIds
  if (!Array.isArray(trackIds)) invalid('trackIds must be an array.')
  if (trackIds.length > MAX_FAVORITE_REMOVE_IDS) {
    invalid(`trackIds must not exceed ${MAX_FAVORITE_REMOVE_IDS} entries.`)
  }
  for (const id of trackIds) assertPositiveInt(id, 'trackIds entry')

  return { trackIds: trackIds as number[] }
}

/**
 * D24's requests — the playlist and artist stars.
 *
 * The same three shapes the track heart validates (toggle, batch state, list),
 * one id space over, and held to the same discipline: `assertOnlyKeys` on every
 * one, the batch bounded by `MAX_FAVORITE_STATE_IDS`, and the list `limit`
 * bounded by `MAX_FAVORITES_PAGE`. The lists are the Quick Menu's short capped
 * views (D26) — one `limit`, no `offset`, no batch ceiling of their own — so
 * they reuse the display-page ceiling as the outer safety bound rather than
 * inventing a second number.
 */
export function assertTogglePlaylistFavoriteRequest(value: unknown): TogglePlaylistFavoriteRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId'])
  return { playlistId: assertPositiveInt(raw.playlistId, 'playlistId') }
}

export function assertPlaylistFavoriteStateRequest(value: unknown): PlaylistFavoriteStateRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistIds'])

  const playlistIds = raw.playlistIds
  if (!Array.isArray(playlistIds)) invalid('playlistIds must be an array.')
  if (playlistIds.length > MAX_FAVORITE_STATE_IDS) {
    invalid(`playlistIds must not exceed ${MAX_FAVORITE_STATE_IDS} entries.`)
  }
  for (const id of playlistIds) assertPositiveInt(id, 'playlistIds entry')

  return { playlistIds: playlistIds as number[] }
}

export function assertListFavoritePlaylistsQuery(value: unknown): ListFavoritePlaylistsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['limit'])
  const limit = assertPositiveInt(raw.limit, 'limit')
  if (limit > MAX_FAVORITES_PAGE) invalid(`limit must not exceed ${MAX_FAVORITES_PAGE}.`)
  return { limit }
}

export function assertToggleArtistFavoriteRequest(value: unknown): ToggleArtistFavoriteRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId'])
  return { artistId: assertPositiveInt(raw.artistId, 'artistId') }
}

export function assertArtistFavoriteStateRequest(value: unknown): ArtistFavoriteStateRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistIds'])

  const artistIds = raw.artistIds
  if (!Array.isArray(artistIds)) invalid('artistIds must be an array.')
  if (artistIds.length > MAX_FAVORITE_STATE_IDS) {
    invalid(`artistIds must not exceed ${MAX_FAVORITE_STATE_IDS} entries.`)
  }
  for (const id of artistIds) assertPositiveInt(id, 'artistIds entry')

  return { artistIds: artistIds as number[] }
}

export function assertListFavoriteArtistsQuery(value: unknown): ListFavoriteArtistsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['limit'])
  const limit = assertPositiveInt(raw.limit, 'limit')
  if (limit > MAX_FAVORITES_PAGE) invalid(`limit must not exceed ${MAX_FAVORITES_PAGE}.`)
  return { limit }
}

/**
 * The related pane's only request (W7-5).
 *
 * One id and nothing else — no limit, no strand selection, no filters. The
 * per-section cap is `RELATED_SECTION_LIMIT` and it is main's to choose: a
 * caller-supplied limit would be a knob whose only effect is how much work the
 * database does on the renderer's say-so, which is the shape of request this
 * boundary exists to refuse.
 */
export function assertRelatedQuery(value: unknown): RelatedQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['trackId'])
  return { trackId: assertPositiveInt(raw.trackId, 'trackId') }
}

/**
 * The modes this channel accepts — **D23**.
 *
 * `action` and `setting` resolve entirely in the renderer and never cross the
 * wire, so a request carrying one is malformed rather than merely empty: main
 * only ever answers `blended`, `artist` or `playlist`.
 */
const SEARCH_QUERY_MODES: readonly SearchMode[] = ['blended', 'artist', 'playlist']

/**
 * The unified search request — **D23**.
 *
 * `text` is trimmed and length-bounded here; the trigram floor for tracks is the
 * store's concern, because a two-character query still has honest album, artist
 * and playlist matches over the LIKE index and refusing it at the seam would
 * deny them. `limitPerGroup` is capped so one keystroke cannot ask main to rank
 * the whole library (RQ2).
 */
export function assertSearchQuery(value: unknown): SearchQuery {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['text', 'mode', 'limitPerGroup'])

  if (typeof raw.text !== 'string') invalid('text must be a string.')
  const text = raw.text.trim()
  if (text.length === 0) invalid('text must not be empty.')
  if ([...text].length > MAX_SEARCH_LENGTH) {
    invalid(`text must not exceed ${MAX_SEARCH_LENGTH} characters.`)
  }

  if (typeof raw.mode !== 'string' || !SEARCH_QUERY_MODES.includes(raw.mode as SearchMode)) {
    invalid(`mode must be one of ${SEARCH_QUERY_MODES.join(', ')}.`)
  }

  const limitPerGroup = assertPositiveInt(raw.limitPerGroup, 'limitPerGroup')
  if (limitPerGroup > MAX_SEARCH_LIMIT_PER_GROUP) {
    invalid(`limitPerGroup must not exceed ${MAX_SEARCH_LIMIT_PER_GROUP}.`)
  }

  return { text, mode: raw.mode as SearchMode, limitPerGroup }
}

/** Recent Additions — one bounded `limit` and nothing else (**D25/D26**). */
export function assertRecentlyAddedAlbumsRequest(value: unknown): { limit: number } {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['limit'])
  const limit = assertPositiveInt(raw.limit, 'limit')
  if (limit > MAX_RECENT_ALBUMS) invalid(`limit must not exceed ${MAX_RECENT_ALBUMS}.`)
  return { limit }
}

/**
 * Validates a request to order an arbitrary id set.
 *
 * Every element is checked rather than sampled: these ids reach a JSON array
 * that SQLite expands with `json_each`, and one non-integer in the middle of ten
 * thousand would surface as an empty or short result rather than as an error.
 */
export function assertOrderTrackIdsQuery(value: unknown): OrderTrackIdsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['sort', 'direction', 'ids'])

  const ids = raw.ids
  if (!Array.isArray(ids)) invalid('ids must be an array.')
  if (ids.length > MAX_ORDERED_TRACK_IDS) {
    invalid(`ids must not exceed ${MAX_ORDERED_TRACK_IDS} entries.`)
  }
  for (const id of ids) assertPositiveInt(id, 'ids entry')

  return { ...assertOrdering(raw), ids: ids as number[] }
}

/**
 * A playlist name the user could have typed.
 *
 * Trimmed and required to be non-empty, because a blank tab is unclickable and
 * indistinguishable from its neighbours — the failure is silent and the user
 * has no way back to the playlist. The length bound exists so a paste accident
 * cannot write a megabyte into a tab label.
 */
/**
 * The trail request: a limit, and nothing else.
 *
 * No offset, because there is no page two — `PLAY_HISTORY_CAP` bounds the whole
 * table. The ceiling is refused here rather than clamped, following every other
 * window in this file: a caller asking for more than the trail can hold has a
 * wrong belief about the cap, and silently serving it fewer rows leaves that
 * belief in place.
 */
export function assertListPlayHistoryQuery(value: unknown): ListPlayHistoryQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['limit'])
  const limit = raw.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    invalid('limit must be a positive integer.')
  }
  if (limit > PLAY_HISTORY_CAP) invalid(`limit must not exceed ${PLAY_HISTORY_CAP}.`)
  return { limit }
}

/**
 * One departed listen.
 *
 * `startedAt` is the one timestamp in the contract the renderer supplies rather
 * than main — see `shared/listens.ts` for why the trail's rule does not
 * transfer. Validated as a positive integer and no further: the log records
 * when the operator's machine says they listened, and a clock that is wrong is
 * a clock that is wrong in `play_history` too. A bound of "not in the future"
 * would reject every listen from a laptop whose time is a minute fast, which is
 * a worse outcome than a row dated a minute early.
 *
 * `msListened` admits zero. The threshold rule lives in the renderer and this
 * is not a second copy of it — a validator that reimplemented "longer than
 * thirty seconds" would be the place the two definitions started to drift.
 */
export function assertRecordListenRequest(value: unknown): RecordListenRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['trackId', 'startedAt', 'msListened'])
  const msListened = raw.msListened
  if (typeof msListened !== 'number' || !Number.isInteger(msListened) || msListened < 0) {
    invalid('msListened must be a non-negative integer.')
  }
  return {
    trackId: assertPositiveInt(raw.trackId, 'trackId'),
    startedAt: assertPositiveInt(raw.startedAt, 'startedAt'),
    msListened
  }
}

/**
 * A closed range in UTC ms.
 *
 * Both ends admit zero, unlike every id in this file: the epoch is a legal
 * instant and "all time" is a range that starts before any listen, which a
 * renderer is entitled to spell as `0`. Ordering is checked because an inverted
 * range is not an empty result the caller meant to ask for — it is a preset
 * computed wrong, and returning zero rows for it would hide the bug behind a
 * dashboard that merely looks like a quiet week.
 *
 * Nothing bounds how far apart the two may be. The scan is served by
 * `idx_listens_started` and a range wider than the log costs what the log costs;
 * the ceiling that matters is on the *response*, and the two requests that can
 * grow one carry it — `MAX_STATS_ROWS` here, `MAX_STATS_BUCKETS` below.
 */
function assertStatsRange(value: unknown, field: string): StatsRange {
  const raw = assertRecord(value, field)
  assertOnlyKeys(raw, ['from', 'to'])

  const from = raw.from
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) {
    invalid('range.from must be a non-negative integer.')
  }

  const to = raw.to
  if (typeof to !== 'number' || !Number.isInteger(to) || to < 0) {
    invalid('range.to must be a non-negative integer.')
  }

  if (to < from) invalid('range.to must not be before range.from.')
  return { from, to }
}

/**
 * A group around one track, or `null` for the whole log.
 *
 * `null` has to be *written*, not left out. The field is the difference between
 * the dashboard's numbers and the deck's, and a caller that forgot it would get
 * the whole library's play count rendered as one track's — an answer that is
 * wrong without looking wrong. An absent field is that mistake; `scope: null` is
 * a decision.
 */
function assertStatsScope(value: unknown): StatsScope | null {
  if (value === null) return null
  const raw = assertRecord(value, 'scope')
  assertOnlyKeys(raw, ['trackId', 'by'])

  const by = raw.by
  if (!STATS_SCOPE_BYS.includes(by as StatsScopeBy)) {
    invalid(`scope.by must be one of: ${STATS_SCOPE_BYS.join(', ')}.`)
  }

  return { trackId: assertPositiveInt(raw.trackId, 'scope.trackId'), by: by as StatsScopeBy }
}

/**
 * The summary's envelope: a range, and what to narrow it to.
 *
 * It carried the range bare until the deck needed one group's totals rather than
 * the library's. Nothing about the scope is bounded — it is one id and one word
 * out of three, and what it does to the response is make it smaller.
 */
export function assertStatsSummaryQuery(value: unknown): StatsSummaryQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['range', 'scope'])
  return {
    range: assertStatsRange(raw.range, 'range'),
    scope: assertStatsScope(raw.scope)
  }
}

/**
 * One ranking request.
 *
 * `dimension` and `sort` are checked against the exported tuples rather than a
 * hand-written union, so adding a fifth dimension to the contract is one edit
 * and not two — the second of which would be the one nobody makes.
 *
 * The page ceiling is `MAX_STATS_ROWS` and it is an order of magnitude below
 * the track-page ceilings on purpose: this response is read off a dashboard,
 * not scrolled, and a caller asking for ten thousand ranked genres wants
 * something the dashboard does not offer.
 */
export function assertStatsQuery(value: unknown): StatsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['range', 'dimension', 'sort', 'limit', 'offset'])

  const dimension = raw.dimension
  if (!STATS_DIMENSIONS.includes(dimension as StatsDimension)) {
    invalid(`dimension must be one of: ${STATS_DIMENSIONS.join(', ')}.`)
  }

  const sort = raw.sort
  if (!STATS_SORTS.includes(sort as StatsSort)) {
    invalid(`sort must be one of: ${STATS_SORTS.join(', ')}.`)
  }

  return {
    range: assertStatsRange(raw.range, 'range'),
    dimension: dimension as StatsDimension,
    sort: sort as StatsSort,
    ...assertWindow(raw, MAX_STATS_ROWS)
  }
}

/**
 * One series request, and the only place in this file where two valid fields
 * are invalid together.
 *
 * Neither the range nor the bucket has a bound of its own — a decade is a fair
 * thing to ask about and an hour is a fair width — but their quotient is the
 * length of the response, and hourly buckets over a decade is 87,600 points
 * crossing the boundary to draw a line two thousand pixels wide. Refused rather
 * than clamped, like every other ceiling here: a caller that gets a silently
 * truncated series draws a chart that stops in 2019 and has no way to know why.
 *
 * The arithmetic is `StatsStore`'s, restated: buckets are fixed widths anchored
 * at `from`, and the `+ 1` is the closed upper end.
 */
export function assertStatsOverTimeQuery(value: unknown): StatsOverTimeQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['range', 'bucket'])

  const bucket = raw.bucket
  if (!STATS_BUCKETS.includes(bucket as StatsBucket)) {
    invalid(`bucket must be one of: ${STATS_BUCKETS.join(', ')}.`)
  }

  const range = assertStatsRange(raw.range, 'range')
  const width = STATS_BUCKET_MS[bucket as StatsBucket]
  const buckets = Math.floor((range.to - range.from) / width) + 1
  if (buckets > MAX_STATS_BUCKETS) {
    invalid(`range and bucket would produce ${buckets} buckets; the limit is ${MAX_STATS_BUCKETS}.`)
  }

  return { range, bucket: bucket as StatsBucket }
}

export function assertPlaylistName(value: unknown): string {
  if (typeof value !== 'string') invalid('name must be a string.')
  const name = value.trim()
  if (name.length === 0) invalid('name must not be empty.')
  if ([...name].length > MAX_PLAYLIST_NAME_LENGTH) {
    invalid(`name must not exceed ${MAX_PLAYLIST_NAME_LENGTH} characters.`)
  }
  return name
}

/**
 * An add or move anchor.
 *
 * The four cases are checked exhaustively rather than by `at` alone: a request
 * claiming `before` without an `entryId` would otherwise reach the store as a
 * lookup for `undefined`, which SQLite answers with no row and the store reads
 * as a deleted entry — a confusing `not-found` for what is a caller bug.
 */
function assertPlaylistInsertion(value: unknown): PlaylistInsertion {
  const raw = assertRecord(value, 'insertion')
  assertOnlyKeys(raw, ['at', 'entryId'])
  switch (raw.at) {
    case 'start':
    case 'end':
      if (raw.entryId !== undefined) invalid(`insertion.at '${raw.at}' takes no entryId.`)
      return { at: raw.at }
    case 'before':
    case 'after':
      return { at: raw.at, entryId: assertPositiveInt(raw.entryId, 'insertion.entryId') }
    default:
      return invalid('insertion.at must be one of: start, end, before, after.')
  }
}

/**
 * A batch of ids for an add, move or remove.
 *
 * Duplicates survive here, unlike in `assertIdSet`. For a filter they are
 * noise; for an add they are intent — D12 makes the same track legal twice, and
 * dropping them would quietly turn "add these two copies" into "add one".
 */
function assertPlaylistIdBatch(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array of positive integers.`)
  if (value.length === 0) invalid(`${field} must not be empty.`)
  if (value.length > MAX_PLAYLIST_BATCH) {
    invalid(`${field} must not exceed ${MAX_PLAYLIST_BATCH} ids.`)
  }
  return value.map((id) => assertPositiveInt(id, `${field} entries`))
}

/**
 * Absent means `position`, which is what the field defaults to and what every
 * caller meant before there was a choice. Rejected rather than coerced when it
 * is present and unknown: a typo'd order silently serving the stored sequence
 * is a bug that looks like the feature not working.
 */
function assertEntryOrder(value: unknown): PlaylistEntryOrder | undefined {
  if (value === undefined) return undefined
  if (value !== 'position' && value !== 'album') {
    invalid("order must be 'position' or 'album'.")
  }
  return value
}

function assertEntriesQuery(value: unknown, maxPage: number): ListPlaylistEntriesQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['playlistId', 'offset', 'limit', 'order'])
  const order = assertEntryOrder(raw.order)
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    ...assertWindow(raw, maxPage),
    ...(order === undefined ? {} : { order })
  }
}

/** Carries no window and no ordering — see the note on the query type. */
export function assertListPlaylistEntryGroupsQuery(value: unknown): ListPlaylistEntryGroupsQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['playlistId'])
  return { playlistId: assertPositiveInt(raw.playlistId, 'playlistId') }
}

export function assertListPlaylistEntriesQuery(value: unknown): ListPlaylistEntriesQuery {
  return assertEntriesQuery(value, MAX_PLAYLIST_ENTRY_PAGE)
}

/** The same window, ids only, at ten times the page ceiling — see the library pair. */
export function assertListPlaylistEntryIdsQuery(value: unknown): ListPlaylistEntryIdsQuery {
  return assertEntriesQuery(value, MAX_PLAYLIST_ENTRY_ID_PAGE)
}

export function assertAddTracksRequest(value: unknown): AddTracksToPlaylistRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'trackIds', 'insertion'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    trackIds: assertPlaylistIdBatch(raw.trackIds, 'trackIds'),
    insertion: assertPlaylistInsertion(raw.insertion)
  }
}

export function assertMoveEntriesRequest(value: unknown): MovePlaylistEntriesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'entryIds', 'insertion'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    entryIds: assertPlaylistIdBatch(raw.entryIds, 'entryIds'),
    insertion: assertPlaylistInsertion(raw.insertion)
  }
}

export function assertRemoveEntriesRequest(value: unknown): RemovePlaylistEntriesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'entryIds'])
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    entryIds: assertPlaylistIdBatch(raw.entryIds, 'entryIds')
  }
}

export function assertExportPlaylistRequest(value: unknown): ExportPlaylistRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['playlistId', 'pathStyle'])
  const pathStyle = raw.pathStyle
  if (typeof pathStyle !== 'string' || !PLAYLIST_PATH_STYLES.includes(pathStyle as never)) {
    invalid(`pathStyle must be one of: ${PLAYLIST_PATH_STYLES.join(', ')}.`)
  }
  return {
    playlistId: assertPositiveInt(raw.playlistId, 'playlistId'),
    pathStyle: pathStyle as PlaylistPathStyle
  }
}

/** Tab order. Zero is a valid destination, so this is not `assertPositiveInt`. */
export function assertTabIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid('toIndex must be a non-negative integer.')
  }
  return value
}

/**
 * A recipe id from the closed 1.0 catalog, and nothing else.
 *
 * An unknown id is refused here rather than becoming a silent no-op inside
 * save: the operator clicked a shelf the pane named, and if that name is not
 * one compose knows, the request is malformed.
 */
export function assertSaveDiscoverShelfRequest(value: unknown): SaveDiscoverShelfRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['recipeId'])
  if (
    typeof raw.recipeId !== 'string' ||
    !(DISCOVER_RECIPE_IDS as readonly string[]).includes(raw.recipeId)
  ) {
    invalid(`recipeId must be one of: ${DISCOVER_RECIPE_IDS.join(', ')}.`)
  }
  return { recipeId: raw.recipeId as DiscoverRecipeId }
}

const MAX_FEED_URL_LENGTH = 2048
const MAX_OPML_CHARS = 2_000_000
const MAX_PODCAST_EPISODE_PAGE = 100
const MAX_PODCAST_RECENT_PAGE = 50

export function assertFeedUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid('feedUrl must be a non-empty string.')
  }
  if ([...value].length > MAX_FEED_URL_LENGTH) {
    invalid(`feedUrl must not exceed ${MAX_FEED_URL_LENGTH} characters.`)
  }
  return value.trim()
}

export function assertOpmlXml(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid('xml must be a non-empty string.')
  }
  if (value.length > MAX_OPML_CHARS) {
    invalid('OPML file is too large.')
  }
  return value
}

export function assertListEpisodesQuery(value: unknown): {
  podcastId: number
  offset: number
  limit: number
} {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['podcastId', 'offset', 'limit'])
  return {
    podcastId: assertPositiveInt(raw.podcastId, 'podcastId'),
    ...assertWindow(raw, MAX_PODCAST_EPISODE_PAGE)
  }
}

export function assertListRecentEpisodesQuery(value: unknown): {
  offset: number
  limit: number
} {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['offset', 'limit'])
  return assertWindow(raw, MAX_PODCAST_RECENT_PAGE)
}

const MAX_CATALOG_SEARCH_TERM = 200
const MAX_CATALOG_SEARCH_LIMIT = 25

export function assertSearchPodcastCatalogQuery(value: unknown): {
  term: string
  limit?: number
} {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['term', 'limit'])
  if (typeof raw.term !== 'string') {
    invalid('term must be a string.')
  }
  const term = raw.term.trim()
  if ([...term].length > MAX_CATALOG_SEARCH_TERM) {
    invalid(`term must not exceed ${MAX_CATALOG_SEARCH_TERM} characters.`)
  }
  if (raw.limit === undefined) return { term }
  if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1) {
    invalid('limit must be a positive integer.')
  }
  return { term, limit: Math.min(raw.limit, MAX_CATALOG_SEARCH_LIMIT) }
}

/**
 * Only the categories the rail actually offers.
 *
 * An allowlist rather than a digit check: `genreId` reaches an outbound URL,
 * and the renderer has no business naming a genre Discover does not show.
 */
export function assertBrowsePodcastCategoryQuery(value: unknown): { genreId: string } {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['genreId'])
  if (typeof raw.genreId !== 'string') {
    invalid('genreId must be a string.')
  }
  const genreId = raw.genreId.trim()
  if (!PODCAST_BROWSE_CATEGORIES.some((category) => category.genreId === genreId)) {
    invalid('genreId is not a known podcast category.')
  }
  return { genreId }
}

/**
 * A serialized setting value's ceiling.
 *
 * Settings hold toggles, numbers and small records. The cap is here rather than
 * in the descriptors because it protects the *column*, not the key: without it
 * one `settings.set` can push an arbitrary blob into the library database, and
 * no individual validator would have been the natural place to notice.
 */
const MAX_SETTING_VALUE_CHARS = 64 * 1024

/**
 * The value survives the trip to a TEXT column.
 *
 * Structured cloning carries things JSON does not — `undefined`, cyclic
 * references, a `Map` — so a payload that arrived intact can still be
 * unstorable. Finding that out here produces a clear rejection; finding it out
 * at the insert produces a `NOT NULL` failure or a throw inside a transaction.
 *
 * What the value *means* is still the descriptor's validator's business, and the
 * settings service runs it before anything is written.
 */
function assertSettingValue(value: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    invalid('value must be JSON-serialisable.')
  }
  if (json === undefined) invalid('value must not be undefined.')
  if (json.length > MAX_SETTING_VALUE_CHARS) {
    invalid(`value must serialise to at most ${MAX_SETTING_VALUE_CHARS} characters.`)
  }
  return value
}

function assertScopeRef(value: unknown): SettingScopeRef {
  const raw = assertRecord(value, 'scope')
  assertOnlyKeys(raw, ['kind', 'id'])

  if (
    typeof raw.kind !== 'string' ||
    !(SETTING_SCOPE_KINDS as readonly string[]).includes(raw.kind)
  ) {
    invalid('scope.kind is not a known scope.')
  }
  const kind = raw.kind as SettingScopeKind

  // Whether this key *accepts* this scope is the service's call — it needs the
  // descriptor's `cascade` to say. This only checks the shape: global carries no
  // id, everything else carries a real one.
  if (kind === 'global') {
    if (raw.id !== null && raw.id !== undefined) invalid('The global scope has no id.')
    return { kind, id: null }
  }
  return { kind, id: assertPositiveInt(raw.id, 'scope.id') }
}

export function assertSetSettingRequest(value: unknown): SetSettingRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['key', 'value', 'scope'])
  if (typeof raw.key !== 'string' || raw.key.trim() === '') {
    invalid('key must be a non-empty string.')
  }
  return {
    key: raw.key,
    value: assertSettingValue(raw.value),
    ...(raw.scope === undefined ? {} : { scope: assertScopeRef(raw.scope) })
  }
}

export function assertGetSettingOverridesRequest(value: unknown): GetSettingOverridesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['scope'])
  return { scope: assertScopeRef(raw.scope) }
}

/**
 * `key` and `category` are alternatives, and naming both is a caller that has
 * not decided which reset it means. Refused rather than silently resolved by
 * precedence — a "reset this category" that quietly resets one key is the sort
 * of thing nobody notices until they have lost a page of settings.
 */
export function assertResetSettingsRequest(value: unknown): ResetSettingsRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['key', 'category', 'scope'])

  if (raw.key !== undefined && raw.category !== undefined) {
    invalid('Reset takes a key or a category, not both.')
  }
  if (raw.key !== undefined && (typeof raw.key !== 'string' || raw.key.trim() === '')) {
    invalid('key must be a non-empty string.')
  }
  if (raw.category !== undefined && typeof raw.category !== 'string') {
    invalid('category must be a string.')
  }

  return {
    ...(raw.key === undefined ? {} : { key: raw.key as string }),
    ...(raw.category === undefined ? {} : { category: raw.category as string }),
    ...(raw.scope === undefined ? {} : { scope: assertScopeRef(raw.scope) })
  }
}

/**
 * A profile's key ceiling.
 *
 * The registry is a few dozen keys and a profile may carry unknown ones from a
 * newer build, so the cap is generous — it is not there to bound a legitimate
 * file, it is there so that a renderer that has gone wrong cannot turn one import
 * into a hundred thousand row writes.
 */
const MAX_PROFILE_KEYS = 2000

/**
 * A settings profile arriving over IPC.
 *
 * Parsed with the same `parseSettingsProfile` that read it off disk, because
 * this one did not come off disk: main handed the renderer a profile and the
 * renderer handed something back, and the boundary's job is to not care that the
 * two are usually the same object. Each value goes through `assertSettingValue`
 * for the reason `settings.set` does — the column is what is being protected.
 */
export function assertImportSettingsProfileRequest(value: unknown): ImportSettingsProfileRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['profile', 'mode'])

  if (
    typeof raw.mode !== 'string' ||
    !(SETTINGS_IMPORT_MODES as readonly string[]).includes(raw.mode)
  ) {
    invalid(`mode must be one of: ${SETTINGS_IMPORT_MODES.join(', ')}.`)
  }

  const parsed = parseSettingsProfile(raw.profile)
  if (!parsed.ok) invalid(`profile is not a settings profile: ${parsed.reason}.`)

  const keys = Object.keys(parsed.profile.settings)
  if (keys.length > MAX_PROFILE_KEYS) {
    invalid(`profile must hold at most ${MAX_PROFILE_KEYS} settings.`)
  }
  for (const key of keys) assertSettingValue(parsed.profile.settings[key].value)

  return { profile: parsed.profile, mode: raw.mode as SettingsImportMode }
}

/**
 * A scope must be one this build cancels.
 *
 * `NET_SCOPES` is a closed list rather than a free string precisely so that a
 * renderer asking to cancel `"tunedck"` gets an error instead of a silent
 * no-op — a cancellation that quietly does nothing is worse than one that
 * fails, because the leak it leaves behind is invisible.
 */
export function assertCancelNetScopeRequest(value: unknown): CancelNetScopeRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['scope'])
  if (typeof raw.scope !== 'string' || !(NET_SCOPES as readonly string[]).includes(raw.scope)) {
    invalid(`scope must be one of: ${NET_SCOPES.join(', ')}.`)
  }
  return { scope: raw.scope as NetScope }
}

/**
 * A target id from the closed list, and nothing else.
 *
 * The same shape guards all three scrobbling channels, so an unknown id is
 * refused at the boundary rather than turning into a `null` lookup three
 * different ways inside the accounts service.
 */
export function assertScrobbleTargetRequest(value: unknown): ScrobbleTargetRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['target'])
  if (
    typeof raw.target !== 'string' ||
    !(SCROBBLE_TARGET_IDS as readonly string[]).includes(raw.target)
  ) {
    invalid(`target must be one of: ${SCROBBLE_TARGET_IDS.join(', ')}.`)
  }
  return { target: raw.target as ScrobbleTargetId }
}

export function assertResolveArtistQuery(value: unknown): ResolveArtistQuery {
  const raw = assertRecord(value, 'query')
  assertOnlyKeys(raw, ['trackId'])
  return { trackId: assertPositiveInt(raw.trackId, 'trackId') }
}

export function assertSearchArtistCandidatesRequest(value: unknown): SearchArtistCandidatesRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId'])
  return { artistId: assertPositiveInt(raw.artistId, 'artistId') }
}

/**
 * The operator's choice, checked for shape before it becomes durable.
 *
 * `mbid: null` is allowed and is not the same as the key being absent — it is
 * "none of these", which the picker offers and which has to survive a restart.
 * `assertOnlyKeys` already rejects the absent case, so the two cannot be
 * confused by a renderer that forgot to send the field.
 *
 * The format check is here rather than only in the service because this value
 * goes into a column other builds will read: an MBID that is not a UUID would
 * be stored, would never match anything at MusicBrainz, and would look for all
 * the world like a resolved artist whose biography simply never loads.
 */
export function assertSetArtistMbidRequest(value: unknown): SetArtistMbidRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId', 'mbid'])
  const artistId = assertPositiveInt(raw.artistId, 'artistId')

  if (raw.mbid === null) return { artistId, mbid: null }
  if (typeof raw.mbid !== 'string' || !isMbid(raw.mbid)) {
    invalid('mbid must be a MusicBrainz identifier, or null.')
  }
  return { artistId, mbid: raw.mbid }
}

export function assertClearArtistMbidRequest(value: unknown): ClearArtistMbidRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId'])
  return { artistId: assertPositiveInt(raw.artistId, 'artistId') }
}

/**
 * No MBID in the request, deliberately.
 *
 * The identifier the two hops start from is read from the `artists` row rather
 * than accepted here — see `wikipedia/service.ts`. That keeps the biography in
 * step with the operator's corrections, and it means the value interpolated into
 * a Wikidata query is one this process wrote.
 */
export function assertGetArtistBiographyRequest(value: unknown): GetArtistBiographyRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId'])
  return { artistId: assertPositiveInt(raw.artistId, 'artistId') }
}

/**
 * No MBID here either, and the same sentence applies with more force.
 *
 * The identifier is read from the `artists` row, so the value interpolated into
 * a MusicBrainz lookup path is one this process wrote — and, more to the point,
 * a renderer cannot ask for the relation graph of an artist it merely believes
 * is playing.
 */
export function assertGetArtistRelationsRequest(value: unknown): GetArtistRelationsRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId'])
  return { artistId: assertPositiveInt(raw.artistId, 'artistId') }
}

/**
 * And once more, for the photograph.
 *
 * No file name and no Commons URL in the request, which is the version of the
 * rule that matters here: this is the one lookup that ends in a fetch of
 * arbitrary bytes, and the address it fetches is derived from a Wikidata claim
 * about an identifier this process wrote. A renderer-supplied URL would make the
 * main process a general-purpose downloader on the renderer's behalf.
 */
export function assertGetArtistImageRequest(value: unknown): GetArtistImageRequest {
  const raw = assertRecord(value, 'request')
  assertOnlyKeys(raw, ['artistId'])
  return { artistId: assertPositiveInt(raw.artistId, 'artistId') }
}
