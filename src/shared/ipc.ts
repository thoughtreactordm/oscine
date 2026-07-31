import type {
  ArtworkVariant,
  GetTracksByIdsQuery,
  LibraryNotice,
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
  ScanProgress,
  ScanSummary,
  Track,
  TrackAudioMetadata
} from './library'
import type {
  AddTracksToPlaylistRequest,
  ExportPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  MovePlaylistEntriesRequest,
  Playlist,
  PlaylistExportResult,
  RemovePlaylistEntriesRequest
} from './playlists'

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
  /**
   * The same two facet windows, resolved to ids only.
   *
   * These exist for the same reason `library.listTrackIds` does — a Shift-range
   * in a facet pane spans rows the pane never loaded — and for one more: a
   * selection passed back as its own filter is how the renderer prunes an album
   * selection when the artist set narrows under it.
   */
  'library.listArtistIds': { request: ListFacetIdsQuery; response: ListFacetIdsResult }
  'library.listAlbumIds': { request: ListFacetIdsQuery; response: ListFacetIdsResult }
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
  'library.listTrackGroups': { request: ListTrackGroupsQuery; response: ListTrackGroupsResult }
  /**
   * Orders an arbitrary set of track ids the way the track list would, so a
   * consumer can read a selection back in list order rather than scraping
   * rendered rows. Ignores browse filters by design; drops unknown ids.
   */
  'library.orderTrackIds': { request: OrderTrackIdsQuery; response: number[] }
  /**
   * Display rows for an id list the caller already has in order.
   *
   * Capped at `MAX_TRACK_PAGE` like every other request that returns rows: the
   * ceiling belongs to the width of the response, not to the size of a
   * selection, so a caller queueing thousands chunks and the wire never carries
   * a page nobody sized for.
   */
  'library.getTracksByIds': { request: GetTracksByIdsQuery; response: Track[] }
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
  /**
   * Every playlist, in tab order. Unpaged: these are tabs, and a user who has
   * made a thousand of them has a different problem than pagination solves.
   */
  'playlists.list': { request: null; response: Playlist[] }
  'playlists.create': {
    request: { name: string; crossfadeMs?: number }
    response: Playlist
  }
  'playlists.rename': { request: { playlistId: number; name: string }; response: Playlist }
  /** R2's per-playlist policy. Persisted here; W3 reads it. */
  'playlists.setCrossfade': {
    request: { playlistId: number; crossfadeMs: number }
    response: Playlist
  }
  /** Cascades to the playlist's entries. The tracks themselves are untouched. */
  'playlists.delete': { request: { playlistId: number }; response: null }
  /**
   * Moves a tab to `toIndex` and returns the whole bar in its new order.
   *
   * Returning the full list rather than the moved playlist is deliberate: a
   * reorder renumbers its neighbours too, so anything less would leave the
   * caller to guess at the result it just asked for.
   */
  'playlists.reorder': {
    request: { playlistId: number; toIndex: number }
    response: Playlist[]
  }
  'playlists.listEntries': {
    request: ListPlaylistEntriesQuery
    response: ListPlaylistEntriesResult
  }
  /** The same window as `playlists.listEntries`, ids only — for range selection. */
  'playlists.listEntryIds': {
    request: ListPlaylistEntryIdsQuery
    response: ListPlaylistEntryIdsResult
  }
  /**
   * The four mutating entry operations, each returning the playlist so the tab
   * badge and `updatedAt` never need a second round trip to stay honest.
   */
  'playlists.addTracks': { request: AddTracksToPlaylistRequest; response: Playlist }
  'playlists.moveEntries': { request: MovePlaylistEntriesRequest; response: Playlist }
  'playlists.removeEntries': { request: RemovePlaylistEntriesRequest; response: Playlist }
  /**
   * D12's interop escape hatch: writes the playlist to a `.m3u8` the operator
   * names in a native save dialog. Resolves `null` when they cancel, following
   * `library.addRoot` — dismissing a dialog is an ordinary outcome and not an
   * error the renderer should have to catch.
   */
  'playlists.exportM3u8': {
    request: ExportPlaylistRequest
    response: PlaylistExportResult | null
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
  'library.listArtistIds',
  'library.listAlbumIds',
  'library.listTracks',
  'library.listTrackIds',
  'library.listTrackGroups',
  'library.orderTrackIds',
  'library.getTracksByIds',
  'library.getTrackAudioMetadata',
  'library.getTrackFileUrl',
  'library.startReplayGain',
  'library.getReplayGainJob',
  'library.cancelReplayGain',
  'library.resumeReplayGain',
  'playlists.list',
  'playlists.create',
  'playlists.rename',
  'playlists.setCrossfade',
  'playlists.delete',
  'playlists.reorder',
  'playlists.listEntries',
  'playlists.listEntryIds',
  'playlists.addTracks',
  'playlists.moveEntries',
  'playlists.removeEntries',
  'playlists.exportM3u8'
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

/** The hash segment standing in for an album that has no cover of its own. */
const MISSING_ARTWORK = 'missing'

/**
 * Builds a closed artwork route. `missing` is a real route backed by the
 * built-in placeholder, so views never need a filesystem path or data payload.
 */
export function artworkUrl(hash: string | null, variant: ArtworkVariant): string {
  return `${TRACK_SCHEME}://artwork/${hash ?? MISSING_ARTWORK}/${variant}`
}

/**
 * Whether a route points at real cover art rather than the placeholder.
 *
 * Views that simply show artwork never need this — the placeholder is a real
 * image and that is the whole point of it. Decoration does: a blurred blow-up
 * of a flat grey square is noise, so a caller using the cover as a backdrop
 * wants to render nothing at all instead.
 */
export function hasArtwork(url: string): boolean {
  return !url.startsWith(`${TRACK_SCHEME}://artwork/${MISSING_ARTWORK}/`)
}
