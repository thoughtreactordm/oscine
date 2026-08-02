import type { ListPlayHistoryQuery, PlayEntry } from './history'
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
  TrackAudioMetadata,
  TrackFormatDetail
} from './library'
import type { CancelNetScopeRequest, CancelNetScopeResult } from './net'
import type { RelatedQuery, RelatedResult } from './related'
import type {
  AddTracksToPlaylistRequest,
  ExportPlaylistRequest,
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryGroupsQuery,
  ListPlaylistEntryGroupsResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  MovePlaylistEntriesRequest,
  Playlist,
  PlaylistExportResult,
  RemovePlaylistEntriesRequest
} from './playlists'
import type {
  BrowsePodcastCategoryQuery,
  BrowsePodcastCategoryResult,
  Episode,
  EpisodeAudioMetadata,
  EpisodeDownloadProgress,
  ImportOpmlResult,
  ListEpisodesQuery,
  ListEpisodesResult,
  ListRecentEpisodesQuery,
  ListRecentEpisodesResult,
  Podcast,
  PodcastRecommendResult,
  SearchPodcastCatalogQuery,
  SearchPodcastCatalogResult,
  SubscribePodcastRequest
} from './podcasts'
import type {
  GetAllSettingsResult,
  GetSettingOverridesRequest,
  GetSettingOverridesResult,
  ImportSettingsProfileRequest,
  ResetSettingsRequest,
  SetSettingRequest,
  SettingsChange,
  SettingsImportPlan,
  SettingsProfileExportResult,
  SettingsProfileFile
} from './settings'

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
  /**
   * Forgets a library folder, and answers with the roots that remain.
   *
   * The response is the new list rather than `null` because this is the one
   * library mutation whose result the caller cannot derive: an add returns the
   * root it added and a scan leaves the list alone, but a removal also prunes
   * albums and artists, and the renderer has no way to know what survived.
   *
   * Nothing is deleted from disk. Ever. The renderer's confirmation says so,
   * and this channel could not do otherwise if it wanted to.
   */
  'library.removeRoot': { request: { rootId: number }; response: LibraryRoot[] }
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
   * Catalog and neighbourhood relations for one track — the Tunedeck's related
   * pane (W7-5).
   *
   * Reads the local index and nothing else. That is a property of the card
   * rather than of the transport, but it is worth stating at the boundary: the
   * MusicBrainz artist-relations pane is a different notion of "related", it
   * arrives in M7, and when it does it will be its own channel rather than a
   * flag on this one. Two sources of truth that disagree should not share a
   * response type.
   *
   * `null` when the seed track has left the library; sections are omitted
   * rather than returned empty, so an absent strand and a strand with no
   * matches are the same thing to the pane.
   */
  'library.getRelated': { request: RelatedQuery; response: RelatedResult | null }
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
   * Re-reads one file's format block for the Tunedeck's signal readout.
   *
   * Separate from `getTrackAudioMetadata` — and from the indexed `Track` — for
   * the reason given on `TrackFormatDetail`: these fields exist in no column,
   * are wanted one track at a time, and are cheaper to re-parse than to migrate
   * and backfill. A control-plane request; no track bytes cross it.
   */
  'library.getTrackFormatDetail': {
    request: { trackId: number }
    response: TrackFormatDetail
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
   * Appends one play to the trail. Main stamps the time; see the service.
   *
   * Reported by the renderer because only the renderer knows what is audible —
   * audio lives there by standing invariant. Resolves `null` when the track
   * left the library between starting and being recorded, which is a race, not
   * a fault.
   */
  'history.record': { request: { trackId: number }; response: PlayEntry | null }
  /**
   * The trail, most recent first. Bare array rather than `{ entries, total }`:
   * `PLAY_HISTORY_CAP` bounds the table, so there is no total the caller does
   * not already have and no page two to offer.
   */
  'history.list': { request: ListPlayHistoryQuery; response: PlayEntry[] }
  /** Erases the trail. A record of what someone listened to is theirs to drop. */
  'history.clear': { request: null; response: null }
  /**
   * Every playlist, in tab order. Unpaged: these are tabs, and a user who has
   * made a thousand of them has a different problem than pagination solves.
   */
  'playlists.list': { request: null; response: Playlist[] }
  'playlists.create': { request: { name: string }; response: Playlist }
  'playlists.rename': { request: { playlistId: number; name: string }; response: Playlist }
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
   * The album runs of a playlist under album-major ordering — the playlist
   * counterpart of `library.listTrackGroups`, and unpaged for the same reason.
   */
  'playlists.listEntryGroups': {
    request: ListPlaylistEntryGroupsQuery
    response: ListPlaylistEntryGroupsResult
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
  /** Every subscription, title order. */
  'podcasts.list': { request: null; response: Podcast[] }
  'podcasts.get': { request: { podcastId: number }; response: Podcast | null }
  'podcasts.subscribe': { request: SubscribePodcastRequest; response: Podcast }
  'podcasts.unsubscribe': { request: { podcastId: number }; response: null }
  'podcasts.refresh': { request: { podcastId: number }; response: Podcast }
  'podcasts.refreshAll': { request: null; response: Podcast[] }
  'podcasts.listEpisodes': { request: ListEpisodesQuery; response: ListEpisodesResult }
  'podcasts.listRecent': { request: ListRecentEpisodesQuery; response: ListRecentEpisodesResult }
  'podcasts.downloadEpisode': { request: { episodeId: number }; response: Episode }
  /** Removes the local file; the episode remains listed as remote. */
  'podcasts.deleteDownload': { request: { episodeId: number }; response: Episode }
  /** Removes every local file for a show; the subscription remains. */
  'podcasts.clearDownloads': { request: { podcastId: number }; response: Podcast }
  'podcasts.setPlayed': {
    request: { episodeId: number; played: boolean }
    response: Episode
  }
  /** Parses OPML text already read in the renderer (paste / file picker). */
  'podcasts.importOpml': { request: { xml: string }; response: ImportOpmlResult }
  'podcasts.getEpisodeFileUrl': { request: { episodeId: number }; response: string }
  'podcasts.getEpisodeAudioMetadata': {
    request: { episodeId: number }
    response: EpisodeAudioMetadata
  }
  /** Apple iTunes Search — keyless catalogue lookup; subscribe still uses feedUrl. */
  'podcasts.searchCatalog': {
    request: SearchPodcastCatalogQuery
    response: SearchPodcastCatalogResult
  }
  /**
   * Discover shelves: genre charts weighted by existing subscriptions, or
   * popular charts when there are none yet. Empty shelves when the catalogue
   * is unreachable — Discover degrades to search rather than erroring.
   */
  'podcasts.recommend': { request: null; response: PodcastRecommendResult }
  /** Top charts for one category off the Discover rail. */
  'podcasts.browseCategory': {
    request: BrowsePodcastCategoryQuery
    response: BrowsePodcastCategoryResult
  }
  /**
   * Every durable key resolved, for renderer hydration.
   *
   * Carries the load notices with it rather than pushing them as events: main
   * resolves settings before the window exists, so a notice raised then has
   * nowhere to go until the renderer asks.
   */
  'settings.getAll': { request: null; response: GetAllSettingsResult }
  /**
   * Every override row at one entity scope, unresolved.
   *
   * Raw rows rather than resolved values because the renderer holds the global
   * layer reactively and resolves the cascade itself — a value resolved in main
   * would be stale the moment the global moved. Scoped rather than per-key so
   * that opening one playlist's settings is one call rather than one per row.
   */
  'settings.getOverrides': {
    request: GetSettingOverridesRequest
    response: GetSettingOverridesResult
  }
  /**
   * Write one key, revalidated in main.
   *
   * The renderer validates too, so the control can refuse a bad value without a
   * round trip — but it is not trusted to have done so, and the response carries
   * back what was actually stored, which may be a repaired version of what was
   * sent.
   */
  'settings.set': { request: SetSettingRequest; response: SettingsChange[] }
  /** One key, one category, or every durable key. */
  'settings.reset': { request: ResetSettingsRequest; response: SettingsChange[] }
  /**
   * Write the portable settings to a file the operator names.
   *
   * `null` when they dismiss the save dialog. The renderer never sees a path:
   * the result carries a bare filename, because a filesystem the renderer cannot
   * touch is not one it should be able to read the shape of either.
   */
  'settings.exportProfile': { request: null; response: SettingsProfileExportResult | null }
  /**
   * Pick and parse a profile without applying it.
   *
   * Reading and importing are two calls because the preview between them is the
   * point: the operator sees what a file would do — and picks merge or replace —
   * before anything is written.
   */
  'settings.readProfile': { request: null; response: SettingsProfileFile | null }
  /**
   * Apply a profile that came back from `settings.readProfile`.
   *
   * The response is the plan main actually applied, recomputed here rather than
   * accepted from the renderer. Both sides run the same pure `planSettingsImport`
   * over the same values, so it should equal the preview — and if a background
   * write moved something in between, this is what says so.
   */
  'settings.importProfile': {
    request: ImportSettingsProfileRequest
    response: SettingsImportPlan
  }

  /**
   * Abandon everything main is fetching on behalf of a scope.
   *
   * The renderer calls this when the thing that wanted the data goes away —
   * the deck closing, in practice. It is a courtesy rather than a guarantee:
   * main never *needs* to be told, because nothing it fetched will be asked for
   * again, but a closed drawer that keeps holding rate-limit slots makes the
   * next open wait behind work nobody wants (**R5**).
   *
   * Deliberately not a fetch channel. The lookups themselves arrive with W7-9;
   * what W7-7 owes the contract is the cancellation half, because it is the
   * half that has to exist before the first fetch does rather than after.
   */
  'net.cancelScope': {
    request: CancelNetScopeRequest
    response: CancelNetScopeResult
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
  'podcasts.downloadProgress': EpisodeDownloadProgress
  /**
   * Durable keys that just changed, and their new values.
   *
   * Broadcast on every write including the renderer's own, so the store applies
   * main's value rather than the one it optimistically sent — that is how a
   * repaired value gets back to the control that submitted it.
   */
  'settings.changed': SettingsChange[]
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
  'library.getRelated',
  'library.removeRoot',
  'library.getTrackAudioMetadata',
  'library.getTrackFormatDetail',
  'library.getTrackFileUrl',
  'library.startReplayGain',
  'library.getReplayGainJob',
  'library.cancelReplayGain',
  'library.resumeReplayGain',
  'history.record',
  'history.list',
  'history.clear',
  'playlists.list',
  'playlists.create',
  'playlists.rename',
  'playlists.delete',
  'playlists.reorder',
  'playlists.listEntries',
  'playlists.listEntryIds',
  'playlists.listEntryGroups',
  'playlists.addTracks',
  'playlists.moveEntries',
  'playlists.removeEntries',
  'playlists.exportM3u8',
  'podcasts.list',
  'podcasts.get',
  'podcasts.subscribe',
  'podcasts.unsubscribe',
  'podcasts.refresh',
  'podcasts.refreshAll',
  'podcasts.listEpisodes',
  'podcasts.listRecent',
  'podcasts.downloadEpisode',
  'podcasts.deleteDownload',
  'podcasts.clearDownloads',
  'podcasts.setPlayed',
  'podcasts.importOpml',
  'podcasts.getEpisodeFileUrl',
  'podcasts.getEpisodeAudioMetadata',
  'podcasts.searchCatalog',
  'podcasts.recommend',
  'podcasts.browseCategory',
  'settings.getAll',
  'settings.getOverrides',
  'settings.set',
  'settings.reset',
  'settings.exportProfile',
  'settings.readProfile',
  'settings.importProfile',
  'net.cancelScope'
] as const satisfies readonly IpcChannel[]

export const IPC_EVENT_CHANNELS = [
  'window.maximizedChange',
  'library.scanProgress',
  'library.notice',
  'library.replayGainProgress',
  'podcasts.downloadProgress',
  'settings.changed'
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

/** Opaque URL for a downloaded episode's bytes. */
export function episodeUrl(episodeId: number): string {
  return `${TRACK_SCHEME}://episode/${episodeId}`
}

/** The `fermata:` hostname that proxies remote catalogue thumbnails. */
export const CATALOG_ARTWORK_HOST = 'catalog-artwork'

/**
 * Hosts main is willing to proxy catalogue artwork from: Apple's podcast CDN
 * and nothing else. A leading dot on the suffix check is the load-bearing
 * character — without it `notmzstatic.com` matches.
 */
export function isCatalogArtworkHost(hostname: string): boolean {
  return hostname === 'mzstatic.com' || hostname.endsWith('.mzstatic.com')
}

/**
 * Re-addresses a catalogue thumbnail so it is fetched by main rather than by
 * the renderer.
 *
 * D14 says nothing leaves the machine except from main, and an `<img>` pointed
 * at Apple's CDN is the renderer opening a socket — it leaks the operator's IP
 * to Apple on every Discover tab open, and it forces a remote origin into
 * `img-src`. Routing through the existing custom protocol keeps both closed.
 *
 * The remote address rides in a query parameter rather than a path segment
 * because `URL` round-trips exactly one of those unambiguously; a `/` inside
 * the value needs no hand-rolled encoding. Returns null for anything off the
 * allowlist so callers render their own placeholder instead of a broken image.
 */
export function catalogArtworkUrl(remote: string | null | undefined): string | null {
  if (!remote) return null
  let target: URL
  try {
    target = new URL(remote)
  } catch {
    return null
  }
  if (target.protocol !== 'https:' || !isCatalogArtworkHost(target.hostname)) return null
  return `${TRACK_SCHEME}://${CATALOG_ARTWORK_HOST}/?u=${encodeURIComponent(target.toString())}`
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
