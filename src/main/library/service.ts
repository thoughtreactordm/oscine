import type {
  GetTracksByIdsQuery,
  LibraryRoot,
  ListAlbumsResult,
  ListArtistsResult,
  ListFacetIdsQuery,
  ListFacetIdsResult,
  ListFacetsQuery,
  ListTrackGroupsQuery,
  ListTrackGroupsResult,
  ListTrackIdsQuery,
  ListTrackIdsResult,
  ListTracksQuery,
  ListTracksResult,
  OrderTrackIdsQuery,
  ReplayGainJobProgress,
  ScanSummary,
  Track,
  TrackAudioMetadata,
  TrackFormatDetail
} from '@shared/library'
import type { RelatedQuery, RelatedResult } from '@shared/related'
import type { AlbumCard } from '@shared/albums'
import type { DiscoverRecipeId, DiscoverShelvesResult } from '@shared/discover'

/**
 * Everything the IPC layer needs from the library, and nothing more.
 *
 * The seam exists so W1-3 could land a complete, typed boundary before W2 had a
 * database behind it. W2-2 supplied the implementation — `SqliteLibraryService`
 * — and, as intended, the contract, the validation and the preload bridge did
 * not move.
 */
export interface LibraryService {
  addRoot(): Promise<LibraryRoot | null>
  listRoots(): Promise<LibraryRoot[]>
  scanRoot(rootId: number): Promise<ScanSummary>
  /**
   * Forgets a library folder and returns the roots that are left.
   *
   * Never touches the filesystem. The tracks go, and with them their play
   * history and any playlist entries pointing at them — all by cascade, which
   * is why the confirmation in the renderer says so.
   *
   * Returns the remaining roots rather than nothing, so a caller that has just
   * changed the list does not have to ask what it now is.
   */
  removeRoot(rootId: number): Promise<LibraryRoot[]>
  listArtists(query: ListFacetsQuery): Promise<ListArtistsResult>
  listAlbums(query: ListFacetsQuery): Promise<ListAlbumsResult>
  /**
   * The same two windows, ids only.
   *
   * Serves a facet Shift-range over pages the pane never loaded, and — by taking
   * a selection as its own filter — prunes one dimension when another narrows.
   */
  listArtistIds(query: ListFacetIdsQuery): Promise<ListFacetIdsResult>
  listAlbumIds(query: ListFacetIdsQuery): Promise<ListFacetIdsResult>
  listTracks(query: ListTracksQuery): Promise<ListTracksResult>
  /**
   * The same window as `listTracks`, ids only.
   *
   * Exists so the renderer can resolve a range selection spanning pages it has
   * never loaded without paying for — or retaining — the display rows.
   */
  listTrackIds(query: ListTrackIdsQuery): Promise<ListTrackIdsResult>
  listTrackGroups(query: ListTrackGroupsQuery): Promise<ListTrackGroupsResult>
  /** Orders an arbitrary id set the way the track list would. Ignores filters. */
  orderTrackIds(query: OrderTrackIdsQuery): Promise<number[]>
  /** Display rows for an id list the caller already ordered. */
  getTracksByIds(query: GetTracksByIdsQuery): Promise<Track[]>
  /**
   * Albums by arrival, newest first — the Quick Menu's Recent Additions
   * (**D25/D26**). Ordered by `MAX(indexed_at)` over each album's tracks and
   * never by `mtime`, so a rescan does not reorder the list. A bare capped array
   * computed on open, not a paged collection.
   */
  recentlyAddedAlbums(limit: number): Promise<AlbumCard[]>
  /**
   * Catalog and neighbourhood relations for one track (W7-5).
   *
   * `null` means the seed track is gone; a result with no sections means it is
   * present and genuinely relates to nothing, which the pane renders
   * differently. Local index only — this channel reaches no network, and in
   * phase 1 there is none to reach.
   */
  getRelated(query: RelatedQuery): Promise<RelatedResult | null>
  /**
   * Today's Discover shelves — named local recipes over the library and the
   * listens log (**D20**). Clock is main's; tests call `compose` with `nowMs`
   * directly.
   */
  discoverShelves(): Promise<DiscoverShelvesResult>
  /**
   * Snapshot one shelf from the last `discover.shelves` result as a name and
   * an ordered track-id list — **D20**. Does not write a playlist; the IPC
   * handler hands those to `playlists.create` / `playlists.addTracks`.
   */
  discoverSaveShelf(recipeId: DiscoverRecipeId): Promise<{ name: string; trackIds: number[] }>
  /** Metadata-only lookup used by the renderer's pre-fetch R1 admission guard. */
  getTrackAudioMetadata(trackId: number): Promise<TrackAudioMetadata | null>
  /**
   * Re-reads one file's format block for the signal readout.
   *
   * Goes to the file rather than to the index because these fields are not
   * indexed — see `TrackFormatDetail`. `null` means the track is no longer in
   * the library; a file that is indexed but unreadable rejects, because those
   * are different states and the pane says so.
   */
  getTrackFormatDetail(trackId: number): Promise<TrackFormatDetail | null>
  /**
   * Absolute path for a track id, or `null` if unknown.
   *
   * Only ever called inside main — by the `oscine://` protocol handler. The
   * return value never crosses IPC.
   */
  resolveTrackPath(trackId: number): Promise<string | null>
  startReplayGain(): Promise<ReplayGainJobProgress>
  getReplayGainJob(): Promise<ReplayGainJobProgress | null>
  cancelReplayGain(jobId: number): Promise<ReplayGainJobProgress>
  resumeReplayGain(jobId: number): Promise<ReplayGainJobProgress>
}
