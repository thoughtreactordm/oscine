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

export const TRACK_SORT_COLUMNS = ['trackNo', 'title', 'artist', 'album', 'durationSec'] as const
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
 */
export interface LibraryBrowseFilters {
  rootId?: number
  /** Album artist identity, falling back to track artist for loose tracks. */
  artistId?: number
  albumId?: number
  /**
   * Literal, user-visible infix terms over title, artist and album.
   * FTS query syntax is never accepted here.
   */
  searchText?: string
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
