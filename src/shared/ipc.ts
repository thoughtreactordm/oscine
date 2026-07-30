import type {
  ArtworkVariant,
  ListAlbumsResult,
  ListArtistsResult,
  ListFacetsQuery,
  LibraryRoot,
  LibraryNotice,
  ListTrackIdsQuery,
  ListTrackIdsResult,
  ListTracksQuery,
  ListTracksResult,
  OrderTrackIdsQuery,
  ReplayGainJobProgress,
  ScanProgress,
  ScanSummary,
  TrackAudioMetadata
} from './library'

/**
 * The single source of truth for the main/renderer seam.
 *
 * Both sides derive their types from the two maps below, so a handler whose
 * shape disagrees with its caller fails at compile time rather than at runtime.
 * Changing a response type here is intended to break both sides at once — that
 * is the point of the file.
 *
 * No Node or Electron imports: the renderer imports this module.
 */

/**
 * Request/response channels, invoked by the renderer and awaited.
 *
 * Use `null` rather than `void` for empty requests: it survives structured
 * cloning unambiguously and keeps the call sites uniform.
 */
export interface IpcContract {
  /** Controls for Fermata's frameless application window. */
  'window.minimize': { request: null; response: null }
  'window.toggleMaximize': { request: null; response: boolean }
  'window.isMaximized': { request: null; response: boolean }
  'window.close': { request: null; response: null }
  /** Opens a native folder picker in main. Resolves `null` if the user cancels. */
  'library.addRoot': { request: null; response: LibraryRoot | null }
  'library.listRoots': { request: null; response: LibraryRoot[] }
  'library.scanRoot': { request: { rootId: number }; response: ScanSummary }
  'library.listArtists': { request: ListFacetsQuery; response: ListArtistsResult }
  'library.listAlbums': { request: ListFacetsQuery; response: ListAlbumsResult }
  'library.listTracks': { request: ListTracksQuery; response: ListTracksResult }
  /**
   * The same window as `library.listTracks`, resolved to ids only.
   *
   * The renderer's selection is a set of track ids, and a Shift-range routinely
   * spans rows it has never loaded. Resolving that range through this channel
   * keeps the page cache bounded no matter how large the selection grows —
   * asking for the rows instead would make every range selection a decision to
   * retain thousands of `Track` objects.
   */
  'library.listTrackIds': { request: ListTrackIdsQuery; response: ListTrackIdsResult }
  /**
   * Orders an arbitrary set of track ids the way the track list would, so a
   * consumer can read a selection back in list order rather than scraping
   * rendered rows. Ignores browse filters by design; drops unknown ids.
   */
  'library.orderTrackIds': { request: OrderTrackIdsQuery; response: number[] }
  /**
   * Supplies only the fields needed to price a decode. This is deliberately a
   * separate metadata request: the R1 guard must decide before it fetches any
   * track bytes.
   */
  'library.getTrackAudioMetadata': {
    request: { trackId: number }
    response: TrackAudioMetadata
  }
  /**
   * Resolves a track id to an opaque `fermata://track/<id>` URL the renderer can
   * fetch. Never returns a filesystem path — see `docs`/the W1-3 card for the
   * reasoning behind the custom protocol.
   */
  'library.getTrackFileUrl': { request: { trackId: number }; response: string }
  'library.startReplayGain': { request: null; response: ReplayGainJobProgress }
  'library.getReplayGainJob': { request: null; response: ReplayGainJobProgress | null }
  'library.cancelReplayGain': {
    request: { jobId: number }
    response: ReplayGainJobProgress
  }
  'library.resumeReplayGain': {
    request: { jobId: number }
    response: ReplayGainJobProgress
  }
}

export type IpcChannel = keyof IpcContract
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request']
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response']

/**
 * One-way channels pushed from main to the renderer.
 *
 * Kept separate from `IpcContract` because the shapes are genuinely different:
 * these have no response, and subscribing requires listener cleanup the
 * request/response path does not. Establishing the pattern here is deliberate —
 * W2-2 needs scan progress, and inventing an ad-hoc mechanism under deadline
 * pressure is how this boundary gets widened badly.
 */
export interface IpcEventContract {
  'window.maximizedChange': boolean
  'library.scanProgress': ScanProgress
  'library.notice': LibraryNotice
  'library.replayGainProgress': ReplayGainJobProgress
}

export type IpcEventChannel = keyof IpcEventContract
export type IpcEventPayload<E extends IpcEventChannel> = IpcEventContract[E]

/**
 * Every channel name, as values.
 *
 * Declared `satisfies` the key unions so adding a channel to a contract without
 * listing it here is a compile error. Main iterates these to assert at startup
 * that no channel was left unhandled.
 */
export const IPC_CHANNELS = [
  'window.minimize',
  'window.toggleMaximize',
  'window.isMaximized',
  'window.close',
  'library.addRoot',
  'library.listRoots',
  'library.scanRoot',
  'library.listArtists',
  'library.listAlbums',
  'library.listTracks',
  'library.listTrackIds',
  'library.orderTrackIds',
  'library.getTrackAudioMetadata',
  'library.getTrackFileUrl',
  'library.startReplayGain',
  'library.getReplayGainJob',
  'library.cancelReplayGain',
  'library.resumeReplayGain'
] as const satisfies readonly IpcChannel[]

export const IPC_EVENT_CHANNELS = [
  'window.maximizedChange',
  'library.scanProgress',
  'library.notice',
  'library.replayGainProgress'
] as const satisfies readonly IpcEventChannel[]

/**
 * Compile-time proof that `IPC_CHANNELS` covers the contract in both directions.
 * If a channel is added to `IpcContract` but not to the array, `Exclude` leaves
 * a residue and this alias stops being `never`, failing the assignment below.
 */
type UnlistedChannel = Exclude<IpcChannel, (typeof IPC_CHANNELS)[number]>
type UnlistedEventChannel = Exclude<IpcEventChannel, (typeof IPC_EVENT_CHANNELS)[number]>

const _allChannelsListed: UnlistedChannel extends never ? true : never = true
const _allEventChannelsListed: UnlistedEventChannel extends never ? true : never = true
void _allChannelsListed
void _allEventChannelsListed

/** The scheme registered in main to serve track bytes. */
export const TRACK_SCHEME = 'fermata'

/**
 * Builds the opaque URL for a track. Lives in shared so main and the renderer
 * cannot disagree about its shape.
 */
export function trackUrl(trackId: number): string {
  return `${TRACK_SCHEME}://track/${trackId}`
}

/**
 * Builds a closed artwork route. `missing` is a real route backed by the
 * built-in placeholder, so views never need a filesystem path or data payload.
 */
export function artworkUrl(hash: string | null, variant: ArtworkVariant): string {
  return `${TRACK_SCHEME}://artwork/${hash ?? 'missing'}/${variant}`
}
