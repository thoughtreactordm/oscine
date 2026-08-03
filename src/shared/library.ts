/**
 * Library domain types crossing the IPC boundary.
 *
 * No Node or Electron imports: the renderer imports this module.
 */

/**
 * A folder the user has added to the library.
 *
 * `path` is deliberately exposed. The Sources panel has to show the user which
 * folder they picked, and a path they chose themselves is not a disclosure.
 * What the renderer must never receive is a path it did not already know — see
 * the note on `Track`.
 */
export interface LibraryRoot {
  id: number
  path: string
  /** ISO 8601, UTC. */
  addedAt: string
  trackCount: number
  watchMode: LibraryWatchMode
}

export type LibraryWatchMode = 'starting' | 'live' | 'startup-scan-only'

/** A typed, user-visible lifecycle finding pushed by main. */
export interface LibraryNotice {
  kind: 'watch-degraded'
  rootId: number
  code: 'ENOSPC'
  message: string
}

/** Where persisted ReplayGain values came from. */
export type ReplayGainSource = 'tag' | 'computed'

/**
 * ReplayGain values stored with a track.
 *
 * Every value is nullable independently because real tag sets are often
 * partial. Gains are decibels; peaks are linear sample ratios. Provenance is
 * retained for diagnostics and the compute-when-missing job, but does not
 * change playback semantics.
 */
export interface TrackReplayGain {
  rgTrackGainDb: number | null
  rgTrackPeak: number | null
  rgAlbumGainDb: number | null
  rgAlbumPeak: number | null
  rgSource: ReplayGainSource | null
}

/**
 * A single indexed track.
 *
 * Note what is absent: there is no `path`, no `relPath`, no filename. The
 * renderer identifies a track solely by `id` and obtains playable bytes through
 * `library.getTrackFileUrl`, which returns an opaque `fermata://` URL. Adding a
 * path field here would hand the renderer an arbitrary-file-read primitive and
 * quietly undo the reason this boundary exists.
 */
export interface Track extends TrackReplayGain {
  id: number
  rootId: number
  title: string
  artist: string | null
  album: string | null
  albumArtist: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  durationSec: number | null
  codec: string | null
  /** Encoded file size, used to budget whole-buffer decode admission. */
  encodedBytes: number
  sampleRateHz: number | null
  channels: number | null
  bitDepth: number | null
  /**
   * Listens this track has crossed the threshold on — **a cache, not a counter**.
   *
   * Derived from the `listens` log (D17) and maintained by the listen commit;
   * `stats.rebuildCounters` recomputes it. It is on the display row because
   * sorting a hundred thousand tracks by it cannot be a `GROUP BY` over the
   * largest table in the database, and it is honest about being a cache because
   * the log can always settle an argument. See `@shared/stats`.
   *
   * Not nullable: a track that has never been listened to has been listened to
   * zero times, and a `null` here would make every consumer decide again what
   * that meant.
   */
  playCount: number
  /** UTC ms of the most recent listen, or `null` for a track never listened to. */
  lastPlayedAt: number | null
  /**
   * Whether `track_favorites` holds this track — **D18**.
   *
   * Resolved in the same query that builds the page, for the reason the heart is
   * worth having at all: a virtualized list draws its rows as they scroll past,
   * and a second round trip per page to decide which of them are filled would
   * cost more than the fact is worth. It is one indexed probe against a table
   * whose primary key *is* the track id.
   *
   * A boolean rather than the timestamp, because the row is the only thing that
   * reads it. The rail orders by `favorited_at` and asks `favorites.list` for it;
   * see `@shared/favorites`.
   */
  favorite: boolean
  artwork: ArtworkUrls
}

/**
 * The metadata the audio engine needs before it decides whether fetching a
 * whole file into the renderer is safe.
 *
 * Kept narrower than `Track`: admission does not need display tags, and a
 * dedicated lookup lets `AudioEngine.load(trackId)` retain its id-only
 * boundary when a track did not originate in the currently rendered page.
 */
export interface TrackAudioMetadata extends TrackReplayGain {
  durationSec: number | null
  encodedBytes: number
  channels: number | null
}

/** Bitrate constancy as the encoder stated it — never as we inferred it. */
export type BitrateMode = 'constant' | 'variable'

/**
 * The format facts that are read from the file rather than from the index.
 *
 * Everything here could have been columns on `tracks`, and deliberately is not.
 * Container, bitrate and codec profile are wanted for exactly one track at a
 * time — the one being looked at in the readout — so a schema migration would
 * have bought three columns that are NULL for every already-indexed track until
 * the operator is talked into a full rescan, in exchange for data no query ever
 * filters or sorts on. Re-parsing one header on demand costs a few milliseconds
 * and is correct on an existing library the moment the pane opens.
 *
 * Distinct from `Track.codec`, which is `normaliseCodec`'s collapsed token: this
 * carries the parser's own strings, because the point of the readout is to say
 * what the file actually is rather than which of six buckets it landed in.
 */
export interface TrackFormatDetail {
  /** The wrapper — `FLAC`, `MPEG`, `Ogg`, `WAVE`. */
  container: string | null
  /** Undigested: `MPEG 1 Layer 3`, `Vorbis I`, `AAC`. */
  codec: string | null
  /** The encoder's own profile string where it states one: `CBR`, `V0`, `LC`. */
  codecProfile: string | null
  /** Bits per second, as the parser reports it. */
  bitrateBps: number | null
  /** `null` when the format does not say, which is most of them. See notes. */
  bitrateMode: BitrateMode | null
  lossless: boolean | null
  /** The encoder that wrote the file, where it signed its work. */
  tool: string | null
}

/**
 * The closed set of columns main will put in an ORDER BY.
 *
 * `playCount` and `lastPlayedAt` sort on the cached columns rather than on an
 * aggregate over `listens`, which is the entire reason the cache exists. They
 * are unindexed, like `durationSec` and for the same reason: a sort is a
 * one-off, an index is a cost on every write, and the first of these to be
 * *measured* slow is the one that earns one.
 */
export const TRACK_SORT_COLUMNS = [
  'trackNo',
  'title',
  'artist',
  'album',
  'durationSec',
  'playCount',
  'lastPlayedAt'
] as const
export type TrackSortColumn = (typeof TRACK_SORT_COLUMNS)[number]

export type SortDirection = 'asc' | 'desc'

export type ArtworkVariant = 'small' | 'large'

/** Opaque display URLs. No source bytes or cache paths cross the boundary. */
export interface ArtworkUrls {
  small: string
  large: string
}

/**
 * Filters shared by every library browser query.
 *
 * IDs are the only dimension identity that crosses IPC. In particular, none of
 * these shapes carries a root path or a track's relative path.
 *
 * The two facet dimensions are sets, and they mean different things in the two
 * directions: within a dimension the ids are a union — any of these artists —
 * while the dimensions AND with each other and with the root and the search
 * text. Selecting two artists and one of their albums therefore narrows to that
 * album, not to everything either artist recorded. An absent field is "no
 * constraint"; an empty array is not permitted, because a caller that meant
 * "match nothing" is far more likely to have meant "match everything" and got
 * there by clearing a selection.
 */
export interface LibraryBrowseFilters {
  rootId?: number
  /** Album artist identities, falling back to track artist for loose tracks. */
  artistIds?: number[]
  albumIds?: number[]
  /**
   * Literal, user-visible infix terms over title, artist and album.
   * FTS query syntax is never accepted here.
   */
  searchText?: string
}

/**
 * The ceiling on one facet dimension of a browse filter.
 *
 * The ids reach SQL through `json_each` rather than as bound parameters, so this
 * is not the 999-parameter limit. What it is set against is facet cardinality: it
 * sits above the number of artists or albums a library of the size D1 targets can
 * contain, so a user cannot reach it by selecting rows that exist. That property
 * is the point — a bound a selection *could* reach would have to be enforced by
 * clamping, and a clamped range selection is silently the wrong selection.
 *
 * The ceiling has to accommodate "select everything", because a full selection is
 * sent in full: a facet omits untagged tracks, so "all of these artists" and "no
 * artist constraint" are genuinely different predicates and the short spelling is
 * not available.
 */
export const MAX_FILTER_IDS = 50_000

/**
 * A filter as plain, structured-cloneable data.
 *
 * Every filter crosses IPC, and IPC clones. The renderer holds its filters in
 * Vue refs and Pinia stores, both of which hand back reactive `Proxy` objects on
 * read — and a `Proxy` cannot be cloned, so an unwrapped array field surfaces as
 * "An object could not be cloned" the moment a selection stops being empty.
 * Primitive fields never had this problem, which is why it arrived with the id
 * sets rather than with the filters themselves.
 *
 * Copying the arrays element by element is what unwraps them: the elements are
 * numbers, so the copy is plain however deeply the container was proxied.
 */
export function plainBrowseFilters(filters: LibraryBrowseFilters): LibraryBrowseFilters {
  return {
    ...filters,
    ...(filters.artistIds === undefined ? {} : { artistIds: [...filters.artistIds] }),
    ...(filters.albumIds === undefined ? {} : { albumIds: [...filters.albumIds] })
  }
}

/**
 * A stable string identity for a filter, independent of how it was assembled.
 *
 * The ids are sorted, so the same three artists reached by clicking down the
 * pane and by clicking up it produce one key rather than two. That matters
 * beyond tidiness: the renderer's play order is identified by this string, and
 * two identities for one list would make Fermata believe the queue had changed
 * underneath a playing track.
 *
 * Lives here rather than in either caller because the track window compares
 * scopes with it and the play order names itself with it, and a filter that
 * hashed differently in those two places would be a bug with no obvious home.
 */
export function browseFilterKey(filters: LibraryBrowseFilters): string {
  return [
    `root:${filters.rootId ?? ''}`,
    browseScopeKey(filters),
    `search:${filters.searchText ?? ''}`
  ].join('|')
}

/**
 * The facet half of the key: what the user has *browsed to*, as opposed to what
 * they have typed. The track list re-defaults its ordering when this changes and
 * deliberately does not when the search text does — typing must not throw away a
 * column the user chose.
 */
export function browseScopeKey(filters: LibraryBrowseFilters): string {
  const ids = (values: readonly number[] | undefined): string =>
    values === undefined ? '' : [...values].sort((a, b) => a - b).join(',')
  return `artists:${ids(filters.artistIds)}|albums:${ids(filters.albumIds)}`
}

/**
 * A window into the track table.
 *
 * Sorting and pagination are the caller's declared intent, executed in SQL.
 * W4-1 targets 100k tracks; sorting renderer-side would mean shipping 100k rows
 * across IPC for every column click.
 */
export interface ListTracksQuery extends LibraryBrowseFilters {
  sort: TrackSortColumn
  direction: SortDirection
  offset: number
  limit: number
}

/**
 * The same window, resolved to ids and nothing else.
 *
 * Identical in shape to `ListTracksQuery` on purpose — the two must describe
 * the same list or a range selection would not line up with the rows the user
 * can see — but the two carry different page ceilings, because an id costs
 * about two orders of magnitude less to ship than a display row.
 */
export type ListTrackIdsQuery = ListTracksQuery

export interface ListTrackIdsResult {
  ids: number[]
  /** Total matching rows, ignoring offset/limit. Same value `listTracks` reports. */
  total: number
}

/**
 * Orders an arbitrary set of track ids the way the track list would.
 *
 * Carries no browse filters, and that is the contract rather than an omission:
 * a selection outlives the search that was active when it was made, so
 * filtering here would drop exactly the rows a selection promises to keep.
 */
/**
 * Display rows for an explicit id list, in the order given.
 *
 * The complement of `orderTrackIds`, and the two are deliberately separate
 * verbs: that one decides a *sequence* for a set with none, this one widens a
 * sequence somebody already has. The up-next queue is what needs it — it holds
 * display snapshots (§5), and a selection of four thousand rows spans pages the
 * list never loaded, so "whatever offered the user the row is holding the
 * `Track` already" stops being true exactly when a multi-select is queued.
 *
 * Ids no longer in the library are omitted rather than reported, as they are
 * from `orderTrackIds` and from a playlist add: the caller wants the survivors,
 * and the shorter result is how it learns the rest are gone.
 */
export interface GetTracksByIdsQuery {
  ids: number[]
}

export interface OrderTrackIdsQuery {
  sort: TrackSortColumn
  direction: SortDirection
  ids: number[]
}

/**
 * One album's run of consecutive rows in the track list.
 *
 * Only meaningful under an album-major ordering, which is why the query accepts
 * no other sort: under `title` the albums interleave and there are no runs to
 * describe.
 *
 * `trackCount` is the field that earns this channel. A grouped list inserts a
 * header row per run, so a display row no longer equals a track offset; prefix
 * sums over the counts convert between the two without the renderer loading a
 * single row, which is what keeps the list virtualized.
 */
export interface TrackGroup {
  /** `null` for the untagged run, which sorts last exactly as its rows do. */
  albumId: number | null
  title: string | null
  albumArtist: string | null
  year: number | null
  trackCount: number
  artwork: ArtworkUrls
}

/**
 * The album runs for a predicate, under the same ordering as the rows.
 *
 * Deliberately unpaged. An artist has tens of albums and the whole library a
 * few thousand, which is small enough to ship whole — and shipping it whole is
 * the only way the renderer can size a grouped list before it has loaded any
 * rows at all.
 */
export interface ListTrackGroupsQuery extends LibraryBrowseFilters {
  sort: TrackSortColumn
  direction: SortDirection
}

export interface ListTrackGroupsResult {
  groups: TrackGroup[]
  /** Total tracks across every run — the same number `listTracks` reports. */
  total: number
}

/**
 * Largest page `library.listTracks` will serve.
 *
 * Lives in `shared` rather than beside the validator because both sides need
 * it: main rejects anything larger, and the renderer sizes its windows against
 * it. A renderer constant that merely happened to agree would drift the first
 * time either number was tuned, and the failure would look like a random
 * `invalid-request` under fast scrolling.
 */
export const MAX_TRACK_PAGE = 1000

/**
 * Largest page `library.listTrackIds` will serve.
 *
 * An order of magnitude above `MAX_TRACK_PAGE` because the response is a flat
 * array of integers rather than the wide display projection with its three
 * dimension joins. That is what lets a 10,000-row Shift-range resolve in one
 * round trip instead of ten, while still refusing to hand the renderer an
 * unbounded result.
 */
export const MAX_TRACK_ID_PAGE = 10_000

/**
 * Largest id set `library.orderTrackIds` will order in one call.
 *
 * Not a page size: ordering cannot be chunked, because subsets ordered
 * independently say nothing about how the chunks interleave. So this is a
 * whole-library ceiling, and a caller holding more selected ids than the
 * library can contain has a bug worth failing on.
 */
export const MAX_ORDERED_TRACK_IDS = 200_000
export const MAX_FACET_PAGE = 500
/** FTS5 trigram search has no indexed terms below three Unicode characters. */
export const MIN_SEARCH_LENGTH = 3
export const MAX_SEARCH_LENGTH = 200

/**
 * Whether this text can match anything at all.
 *
 * The query builder drops every term shorter than a trigram, so a phrase made
 * only of short words compiles to an empty `MATCH` — which is not a narrow
 * search, it is a broken one. The sidebar has always applied this rule to what
 * the operator types; it is here rather than private to that store because the
 * Listening dashboard applies it to text the operator did *not* type. A row
 * whose reveal would compile to nothing is drawn as plain text instead of as a
 * link that silently does nothing, and deciding that in two places is deciding
 * it twice.
 */
export function isSearchable(text: string): boolean {
  return text
    .trim()
    .split(/\s+/u)
    .some((term) => [...term].length >= MIN_SEARCH_LENGTH)
}

export interface ListTracksResult {
  tracks: Track[]
  /** Total matching rows, ignoring offset/limit, so the UI can size its scrollbar. */
  total: number
}

/** One artist row in the paged browser facet. */
export interface ArtistFacet {
  id: number
  name: string
  trackCount: number
}

/** One album row in the paged browser facet. */
export interface AlbumFacet {
  id: number
  title: string
  albumArtist: string | null
  year: number | null
  trackCount: number
  artwork: ArtworkUrls
}

export interface ListFacetsQuery extends LibraryBrowseFilters {
  offset: number
  limit: number
}

export interface ListArtistsResult {
  artists: ArtistFacet[]
  total: number
}

export interface ListAlbumsResult {
  albums: AlbumFacet[]
  total: number
}

/**
 * A facet window resolved to ids and nothing else.
 *
 * Same shape and same ordering as `ListFacetsQuery`, which is the contract
 * rather than a coincidence: a Shift-range in a facet pane spans index
 * positions, so the ids for a span have to be the ids the user would have seen
 * at those positions. Assembling them from display pages instead would mean
 * retaining those pages, and a range selection is precisely the operation that
 * must not grow the page cache.
 *
 * It carries the second job of pruning. Passing a selection back as its own
 * filter — `listAlbumIds({ ...filters, albumIds: selected })` — answers "which
 * of these still exist under the narrowed predicate" with a query bounded by the
 * selection rather than by the library.
 */
export type ListFacetIdsQuery = ListFacetsQuery

export interface ListFacetIdsResult {
  ids: number[]
  /** Total matching facet rows, ignoring offset/limit. */
  total: number
}

/**
 * An id costs about two orders of magnitude less to ship than a display row —
 * an album row carries a title, an artist name and two artwork URLs — so the
 * page ceiling here is correspondingly higher than `MAX_FACET_PAGE`. It equals
 * `MAX_FILTER_IDS` so that any range a user can select resolves in one request:
 * a range that needed two would have to be stitched, and a stitch that failed
 * halfway would leave a selection nobody asked for.
 */
export const MAX_FACET_ID_PAGE = MAX_FILTER_IDS

export interface ScanSummary {
  rootId: number
  filesSeen: number
  tracksIndexed: number
  filesSkipped: number
  /** ISO 8601, UTC. */
  startedAt: string
  /** ISO 8601, UTC. */
  finishedAt: string
}

/** Emitted repeatedly during a scan so the UI can show progress. */
export interface ScanProgress {
  rootId: number
  filesSeen: number
  tracksIndexed: number
  /**
   * Basename only, never a full path — this is a status line, not a location.
   * A full path here would leak the filesystem layout into the renderer for no
   * benefit the user can see.
   */
  currentFile: string | null
  done: boolean
}

export type ReplayGainJobState = 'running' | 'cancelling' | 'paused' | 'cancelled' | 'completed'

/**
 * Durable ReplayGain job progress.
 *
 * `currentTitle` is display metadata already exposed by `Track`; paths remain
 * main-only. Counts are derived from checkpoint rows, so this shape is equally
 * valid immediately after an app restart.
 */
export interface ReplayGainJobProgress {
  jobId: number
  state: ReplayGainJobState
  total: number
  completed: number
  failed: number
  pending: number
  currentTitle: string | null
  /** ISO 8601, UTC. */
  updatedAt: string
  done: boolean
}
