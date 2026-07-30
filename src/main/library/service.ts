import type {
  LibraryRoot,
  ListAlbumsResult,
  ListArtistsResult,
  ListFacetsQuery,
  ListTrackIdsQuery,
  ListTrackIdsResult,
  ListTracksQuery,
  ListTracksResult,
  OrderTrackIdsQuery,
  ReplayGainJobProgress,
  ScanSummary,
  TrackAudioMetadata
} from '@shared/library'

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
  listArtists(query: ListFacetsQuery): Promise<ListArtistsResult>
  listAlbums(query: ListFacetsQuery): Promise<ListAlbumsResult>
  listTracks(query: ListTracksQuery): Promise<ListTracksResult>
  /**
   * The same window as `listTracks`, ids only.
   *
   * Exists so the renderer can resolve a range selection spanning pages it has
   * never loaded without paying for — or retaining — the display rows.
   */
  listTrackIds(query: ListTrackIdsQuery): Promise<ListTrackIdsResult>
  /** Orders an arbitrary id set the way the track list would. Ignores filters. */
  orderTrackIds(query: OrderTrackIdsQuery): Promise<number[]>
  /** Metadata-only lookup used by the renderer's pre-fetch R1 admission guard. */
  getTrackAudioMetadata(trackId: number): Promise<TrackAudioMetadata | null>
  /**
   * Absolute path for a track id, or `null` if unknown.
   *
   * Only ever called inside main — by the `fermata://` protocol handler. The
   * return value never crosses IPC.
   */
  resolveTrackPath(trackId: number): Promise<string | null>
  startReplayGain(): Promise<ReplayGainJobProgress>
  getReplayGainJob(): Promise<ReplayGainJobProgress | null>
  cancelReplayGain(jobId: number): Promise<ReplayGainJobProgress>
  resumeReplayGain(jobId: number): Promise<ReplayGainJobProgress>
}
