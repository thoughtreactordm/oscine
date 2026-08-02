import { BrowserWindow } from 'electron'
import { FermataError } from '@shared/errors'
import { trackUrl } from '@shared/ipc'
import type { PlayHistoryService } from '../history/service'
import type { LibraryService } from '../library/service'
import type { PlaylistService } from '../library/playlists/service'
import type { PodcastService } from '../podcasts/service'
import type { SettingsService } from '../settings/service'
import { assertEveryChannelHandled, handle } from './registry'
import {
  assertAddTracksRequest,
  assertExportPlaylistRequest,
  assertFeedUrl,
  assertBrowsePodcastCategoryQuery,
  assertSearchPodcastCatalogQuery,
  assertListEpisodesQuery,
  assertListFacetIdsQuery,
  assertListFacetsQuery,
  assertListPlayHistoryQuery,
  assertListPlaylistEntriesQuery,
  assertListPlaylistEntryGroupsQuery,
  assertListPlaylistEntryIdsQuery,
  assertListRecentEpisodesQuery,
  assertListTrackGroupsQuery,
  assertListTrackIdsQuery,
  assertListTracksQuery,
  assertMoveEntriesRequest,
  assertGetSettingOverridesRequest,
  assertGetTracksByIdsQuery,
  assertImportSettingsProfileRequest,
  assertOpmlXml,
  assertOrderTrackIdsQuery,
  assertPlaylistName,
  assertPositiveInt,
  assertRecord,
  assertRemoveEntriesRequest,
  assertResetSettingsRequest,
  assertSetSettingRequest,
  assertTabIndex
} from './validate'

/**
 * Wires every channel in the contract to the library service.
 *
 * Handlers stay thin on purpose: validate, delegate, return. Anything they
 * throw is flattened by the registry before it reaches the renderer.
 */
export function registerIpcHandlers(
  library: LibraryService,
  playlists: PlaylistService,
  podcasts: PodcastService,
  settings: SettingsService,
  history: PlayHistoryService
): void {
  handle('window.minimize', (_request, event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return null
  })

  handle('window.toggleMaximize', (_request, event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  handle('window.isMaximized', (_request, event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  handle('window.close', (_request, event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return null
  })

  handle('library.addRoot', () => library.addRoot())

  handle('library.listRoots', () => library.listRoots())

  handle('library.scanRoot', (request) => {
    const { rootId } = assertRecord(request, 'request')
    return library.scanRoot(assertPositiveInt(rootId, 'rootId'))
  })

  handle('library.listArtists', (request) => library.listArtists(assertListFacetsQuery(request)))

  handle('library.listAlbums', (request) => library.listAlbums(assertListFacetsQuery(request)))

  handle('library.listArtistIds', (request) =>
    library.listArtistIds(assertListFacetIdsQuery(request))
  )

  handle('library.listAlbumIds', (request) =>
    library.listAlbumIds(assertListFacetIdsQuery(request))
  )

  handle('library.listTracks', (request) => library.listTracks(assertListTracksQuery(request)))

  handle('library.listTrackGroups', (request) =>
    library.listTrackGroups(assertListTrackGroupsQuery(request))
  )

  handle('library.listTrackIds', (request) =>
    library.listTrackIds(assertListTrackIdsQuery(request))
  )

  handle('library.orderTrackIds', (request) =>
    library.orderTrackIds(assertOrderTrackIdsQuery(request))
  )

  handle('library.getTracksByIds', (request) =>
    library.getTracksByIds(assertGetTracksByIdsQuery(request))
  )

  handle('library.getTrackAudioMetadata', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const metadata = await library.getTrackAudioMetadata(assertPositiveInt(trackId, 'trackId'))
    if (!metadata) {
      throw new FermataError('not-found', 'That track is no longer in the library.')
    }
    return metadata
  })

  handle('library.getTrackFormatDetail', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const detail = await library.getTrackFormatDetail(assertPositiveInt(trackId, 'trackId'))
    if (!detail) {
      throw new FermataError('not-found', 'That track is no longer in the library.')
    }
    return detail
  })

  handle('library.getTrackFileUrl', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const id = assertPositiveInt(trackId, 'trackId')

    // Confirm the track exists before minting a URL, so a bad id fails here
    // with a clear error rather than as an opaque 404 during playback. The
    // resolved path is deliberately discarded — only the id goes back.
    if ((await library.resolveTrackPath(id)) === null) {
      throw new FermataError('not-found', 'That track is no longer in the library.')
    }
    return trackUrl(id)
  })

  handle('library.startReplayGain', () => library.startReplayGain())

  handle('library.getReplayGainJob', () => library.getReplayGainJob())

  handle('library.cancelReplayGain', (request) => {
    const { jobId } = assertRecord(request, 'request')
    return library.cancelReplayGain(assertPositiveInt(jobId, 'jobId'))
  })

  handle('library.resumeReplayGain', (request) => {
    const { jobId } = assertRecord(request, 'request')
    return library.resumeReplayGain(assertPositiveInt(jobId, 'jobId'))
  })

  handle('history.record', (request) => {
    const { trackId } = assertRecord(request, 'request')
    return history.record(assertPositiveInt(trackId, 'trackId'))
  })

  handle('history.list', (request) => history.list(assertListPlayHistoryQuery(request)))

  handle('history.clear', async () => {
    await history.clear()
    return null
  })

  handle('playlists.list', () => playlists.list())

  handle('playlists.create', (request) => {
    const { name } = assertRecord(request, 'request')
    return playlists.create(assertPlaylistName(name))
  })

  handle('playlists.rename', (request) => {
    const { playlistId, name } = assertRecord(request, 'request')
    return playlists.rename(assertPositiveInt(playlistId, 'playlistId'), assertPlaylistName(name))
  })

  handle('playlists.delete', async (request) => {
    const { playlistId } = assertRecord(request, 'request')
    await playlists.delete(assertPositiveInt(playlistId, 'playlistId'))
    return null
  })

  handle('playlists.reorder', (request) => {
    const { playlistId, toIndex } = assertRecord(request, 'request')
    return playlists.reorder(assertPositiveInt(playlistId, 'playlistId'), assertTabIndex(toIndex))
  })

  handle('playlists.listEntries', (request) =>
    playlists.listEntries(assertListPlaylistEntriesQuery(request))
  )

  handle('playlists.listEntryIds', (request) =>
    playlists.listEntryIds(assertListPlaylistEntryIdsQuery(request))
  )

  handle('playlists.listEntryGroups', (request) =>
    playlists.listEntryGroups(assertListPlaylistEntryGroupsQuery(request))
  )

  handle('playlists.addTracks', (request) => playlists.addTracks(assertAddTracksRequest(request)))

  handle('playlists.moveEntries', (request) =>
    playlists.moveEntries(assertMoveEntriesRequest(request))
  )

  handle('playlists.removeEntries', (request) =>
    playlists.removeEntries(assertRemoveEntriesRequest(request))
  )

  handle('playlists.exportM3u8', (request) =>
    playlists.exportM3u8(assertExportPlaylistRequest(request))
  )

  handle('podcasts.list', () => podcasts.listPodcasts())

  handle('podcasts.get', (request) => {
    const { podcastId } = assertRecord(request, 'request')
    return podcasts.getPodcast(assertPositiveInt(podcastId, 'podcastId'))
  })

  handle('podcasts.subscribe', (request) => {
    const { feedUrl } = assertRecord(request, 'request')
    return podcasts.subscribe(assertFeedUrl(feedUrl))
  })

  handle('podcasts.unsubscribe', async (request) => {
    const { podcastId } = assertRecord(request, 'request')
    await podcasts.unsubscribe(assertPositiveInt(podcastId, 'podcastId'))
    return null
  })

  handle('podcasts.refresh', (request) => {
    const { podcastId } = assertRecord(request, 'request')
    return podcasts.refresh(assertPositiveInt(podcastId, 'podcastId'))
  })

  handle('podcasts.refreshAll', () => podcasts.refreshAll())

  handle('podcasts.listEpisodes', (request) =>
    podcasts.listEpisodes(assertListEpisodesQuery(request))
  )

  handle('podcasts.listRecent', (request) =>
    podcasts.listRecent(assertListRecentEpisodesQuery(request))
  )

  handle('podcasts.downloadEpisode', (request) => {
    const { episodeId } = assertRecord(request, 'request')
    return podcasts.downloadEpisode(assertPositiveInt(episodeId, 'episodeId'))
  })

  handle('podcasts.deleteDownload', (request) => {
    const { episodeId } = assertRecord(request, 'request')
    return podcasts.deleteDownload(assertPositiveInt(episodeId, 'episodeId'))
  })

  handle('podcasts.clearDownloads', (request) => {
    const { podcastId } = assertRecord(request, 'request')
    return podcasts.clearDownloads(assertPositiveInt(podcastId, 'podcastId'))
  })

  handle('podcasts.setPlayed', (request) => {
    const { episodeId, played } = assertRecord(request, 'request')
    if (typeof played !== 'boolean') {
      throw new FermataError('invalid-request', 'played must be a boolean.')
    }
    return podcasts.setPlayed(assertPositiveInt(episodeId, 'episodeId'), played)
  })

  handle('podcasts.importOpml', (request) => {
    const { xml } = assertRecord(request, 'request')
    return podcasts.importOpml(assertOpmlXml(xml))
  })

  handle('podcasts.getEpisodeFileUrl', (request) => {
    const { episodeId } = assertRecord(request, 'request')
    return podcasts.getEpisodeFileUrl(assertPositiveInt(episodeId, 'episodeId'))
  })

  handle('podcasts.getEpisodeAudioMetadata', (request) => {
    const { episodeId } = assertRecord(request, 'request')
    return podcasts.getEpisodeAudioMetadata(assertPositiveInt(episodeId, 'episodeId'))
  })

  handle('podcasts.searchCatalog', (request) => {
    const query = assertSearchPodcastCatalogQuery(request)
    return podcasts.searchCatalog(query.term, query.limit)
  })

  handle('podcasts.recommend', () => podcasts.recommend())

  handle('podcasts.browseCategory', (request) => {
    const { genreId } = assertBrowsePodcastCategoryQuery(request)
    return podcasts.browseCategory(genreId)
  })

  handle('settings.getAll', () => settings.getAll())

  handle('settings.getOverrides', (request) =>
    settings.getOverrides(assertGetSettingOverridesRequest(request).scope)
  )

  handle('settings.set', (request) => settings.set(assertSetSettingRequest(request)))

  handle('settings.reset', (request) => settings.reset(assertResetSettingsRequest(request)))

  handle('settings.exportProfile', () => settings.exportProfile())

  handle('settings.readProfile', () => settings.readProfile())

  handle('settings.importProfile', (request) =>
    settings.importProfile(assertImportSettingsProfileRequest(request))
  )

  assertEveryChannelHandled()
}

export { emit, setTrustedRendererUrl } from './registry'
