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

/**
 * A window into the track table.
 *
 * Sorting and pagination are the caller's declared intent, executed in SQL.
 * W4-1 targets 100k tracks; sorting renderer-side would mean shipping 100k rows
 * across IPC for every column click.
 */
export interface ListTracksQuery {
  rootId?: number
  sort: TrackSortColumn
  direction: SortDirection
  offset: number
  limit: number
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

export interface ListTracksResult {
  tracks: Track[]
  /** Total matching rows, ignoring offset/limit, so the UI can size its scrollbar. */
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
