import { app, BrowserWindow, shell } from 'electron'
import { OscineError } from '@shared/errors'
import { trackUrl } from '@shared/ipc'
import type { FavoriteService } from '../favorites/service'
import type { PlayHistoryService } from '../history/service'
import type { LibraryService } from '../library/service'
import type { ListenService } from '../listens/service'
import type { PlaylistService } from '../library/playlists/service'
import type {
  ArtistIdentityService,
  ArtistLinksService,
  ArtistRelationsService,
  TagSuggestionService
} from '../musicbrainz'
import type { NetService } from '../net'
import type { ScrobbleAccountsService } from '../scrobble/accounts'
import type { ScrobbleStatusService } from '../scrobble/status'
import type { SearchService } from '../search/service'
import type { PodcastService } from '../podcasts/service'
import type { SettingsService } from '../settings/service'
import type { StatsService } from '../stats/service'
import type { TagStore } from '../tags/store'
import type { ArtistBiographyService, ArtistImageService } from '../wikipedia'
import { assertEveryChannelHandled, handle } from './registry'
import {
  assertAddTracksRequest,
  assertCancelNetScopeRequest,
  assertScrobbleTargetRequest,
  assertClearArtistMbidRequest,
  assertGetArtistBiographyRequest,
  assertGetArtistImageRequest,
  assertGetArtistLinksRequest,
  assertGetArtistRelationsRequest,
  assertResolveArtistQuery,
  assertSearchArtistCandidatesRequest,
  assertSetArtistMbidRequest,
  assertArtistFavoritesQuery,
  assertExportPlaylistRequest,
  assertFavoriteStateRequest,
  assertFeedUrl,
  assertBrowsePodcastCategoryQuery,
  assertSearchPodcastCatalogQuery,
  assertListEpisodesQuery,
  assertListFacetIdsQuery,
  assertListFacetsQuery,
  assertListFavoriteIdsQuery,
  assertListFavoritesQuery,
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
  assertRelatedQuery,
  assertImportSettingsProfileRequest,
  assertOpenExternalRequest,
  assertOpmlXml,
  assertOrderTrackIdsQuery,
  assertPlaylistName,
  assertPositiveInt,
  assertRecord,
  assertRecordListenRequest,
  assertRemoveEntriesRequest,
  assertRemoveFavoritesRequest,
  assertResetSettingsRequest,
  assertSaveDiscoverShelfRequest,
  assertSetSettingRequest,
  assertStatsOverTimeQuery,
  assertStatsQuery,
  assertStatsSummaryQuery,
  assertTabIndex,
  assertToggleFavoriteRequest,
  assertTogglePlaylistFavoriteRequest,
  assertPlaylistFavoriteStateRequest,
  assertListFavoritePlaylistsQuery,
  assertToggleArtistFavoriteRequest,
  assertArtistFavoriteStateRequest,
  assertListFavoriteArtistsQuery,
  assertSearchQuery,
  assertRecentlyAddedAlbumsRequest,
  assertTrackTagsRequest,
  assertArtistTagsRequest,
  assertAddTagsRequest,
  assertRemoveTagRequest,
  assertRenameTagRequest,
  assertSuggestTagsRequest
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
  history: PlayHistoryService,
  listens: ListenService,
  stats: StatsService,
  favorites: FavoriteService,
  net: NetService,
  scrobble: ScrobbleAccountsService,
  scrobbleStatus: ScrobbleStatusService,
  artists: ArtistIdentityService,
  biographies: ArtistBiographyService,
  relations: ArtistRelationsService,
  images: ArtistImageService,
  links: ArtistLinksService,
  search: SearchService,
  tags: TagStore,
  tagSuggestions: TagSuggestionService
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

  handle('app.getVersion', () => app.getVersion())

  handle('app.openExternal', (request) => {
    const { url } = assertOpenExternalRequest(request)
    void shell.openExternal(url)
    return null
  })

  handle('library.addRoot', () => library.addRoot())

  handle('library.listRoots', () => library.listRoots())

  handle('library.scanRoot', (request) => {
    const { rootId } = assertRecord(request, 'request')
    return library.scanRoot(assertPositiveInt(rootId, 'rootId'))
  })

  handle('library.removeRoot', (request) => {
    const { rootId } = assertRecord(request, 'request')
    return library.removeRoot(assertPositiveInt(rootId, 'rootId'))
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

  // Null rather than a `not-found` throw, unlike the two handlers below it. The
  // seed here is whatever is playing, and a track can legitimately leave the
  // library while its own row is on screen — the pane's answer to that is the
  // same empty state it shows for a track that relates to nothing, so making it
  // an error would mean the store catching an exception on a normal race.
  handle('library.getRelated', (request) => library.getRelated(assertRelatedQuery(request)))

  // No `not-found`: a track that has left the library answers with two nulls,
  // which the Tags pane reads as "album/artist batch does not apply" — the same
  // race `getRelated` above tolerates, and for the same reason.
  handle('library.trackFacets', (request) => {
    const { trackId } = assertRecord(request, 'request')
    return library.trackFacets(assertPositiveInt(trackId, 'trackId'))
  })

  handle('library.getTrackAudioMetadata', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const metadata = await library.getTrackAudioMetadata(assertPositiveInt(trackId, 'trackId'))
    if (!metadata) {
      throw new OscineError('not-found', 'That track is no longer in the library.')
    }
    return metadata
  })

  handle('library.getTrackFormatDetail', async (request) => {
    const { trackId } = assertRecord(request, 'request')
    const detail = await library.getTrackFormatDetail(assertPositiveInt(trackId, 'trackId'))
    if (!detail) {
      throw new OscineError('not-found', 'That track is no longer in the library.')
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
      throw new OscineError('not-found', 'That track is no longer in the library.')
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

  handle('listens.record', (request) => listens.record(assertRecordListenRequest(request)))

  handle('listens.flushed', () => {
    listens.acknowledgeFlush()
    return null
  })

  handle('stats.rebuildCounters', () => stats.rebuildCounters())

  handle('stats.query', (request) => stats.query(assertStatsQuery(request)))

  handle('stats.summary', (request) => stats.summary(assertStatsSummaryQuery(request)))

  handle('stats.overTime', (request) => stats.overTime(assertStatsOverTimeQuery(request)))

  // No `not-found` throw for a track that has left the library, unlike the three
  // library lookups above. The click happened over a row that was on screen, and
  // a track that has since gone is not favorited — which is an answer, and the
  // one the returned state carries. See the channel's own note in the contract.
  handle('favorites.toggle', (request) =>
    favorites.toggle(assertToggleFavoriteRequest(request).trackId)
  )

  handle('favorites.state', (request) =>
    favorites.state(assertFavoriteStateRequest(request).trackIds)
  )

  handle('favorites.list', (request) => favorites.list(assertListFavoritesQuery(request)))

  handle('favorites.listIds', (request) => favorites.listIds(assertListFavoriteIdsQuery(request)))

  // No `not-found` throw for a seed that has left the library, unlike the
  // library lookups above and for `favorites.toggle`'s reason. The honest answer
  // about a track that is gone is that there is no artist to list favorites for,
  // which is the same answer as for a track that never named one — and the pane
  // draws the same sentence for both.
  handle('favorites.byArtist', (request) => favorites.byArtist(assertArtistFavoritesQuery(request)))

  handle('favorites.remove', (request) =>
    favorites.remove(assertRemoveFavoritesRequest(request).trackIds)
  )

  // The playlist and artist stars — D24. Owned by the same service as the track
  // heart, but with none of its network arrangement: a star is a local fact, so
  // these are plain reads and writes and the star glyph is entirely the
  // renderer's to draw.
  handle('favorites.togglePlaylist', (request) =>
    favorites.togglePlaylist(assertTogglePlaylistFavoriteRequest(request).playlistId)
  )

  handle('favorites.playlistState', (request) =>
    favorites.playlistState(assertPlaylistFavoriteStateRequest(request).playlistIds)
  )

  handle('favorites.listPlaylists', (request) =>
    favorites.listPlaylists(assertListFavoritePlaylistsQuery(request).limit)
  )

  handle('favorites.toggleArtist', (request) =>
    favorites.toggleArtist(assertToggleArtistFavoriteRequest(request).artistId)
  )

  handle('favorites.artistState', (request) =>
    favorites.artistState(assertArtistFavoriteStateRequest(request).artistIds)
  )

  handle('favorites.listArtists', (request) =>
    favorites.listArtists(assertListFavoriteArtistsQuery(request).limit)
  )

  // W15 — the user-tag surface. The store is the service here: these handlers are
  // the same thin validate-delegate-return, straight onto `TagStore`, with no
  // network arrangement to wrap because a tag is a local fact end to end.
  handle('tags.list', () => tags.listTags())

  handle('tags.forTrack', (request) => tags.tagsForTrack(assertTrackTagsRequest(request).trackId))

  // W15-7 — the artist altitude. Coverage over the browse-dimension artist's own
  // track set, resolved in one grouped pass in the store; no id list crosses the
  // wire, just the facet id the Track pane already resolves for its batch.
  handle('tags.forArtist', (request) =>
    tags.tagsForArtist(assertArtistTagsRequest(request).artistId)
  )

  // `'user'` is fixed, not taken from the request: everything the renderer adds
  // is the operator's own, and the `'suggested'` source is the suggestion
  // pipeline's to write once it exists, never a caller's to claim.
  handle('tags.add', (request) => {
    const { trackIds, label } = assertAddTagsRequest(request)
    return tags.addTag(trackIds, label, 'user')
  })

  handle('tags.remove', (request) => {
    const { trackIds, tagId } = assertRemoveTagRequest(request)
    return tags.removeTag(trackIds, tagId)
  })

  handle('tags.rename', (request) => {
    const { tagId, label } = assertRenameTagRequest(request)
    return tags.renameTag(tagId, label)
  })

  // W15-4 — the networked half. The service resolves the track's artist MBID,
  // goes through the D14 gate, and dedups against what the track already carries;
  // a decline or an offline machine answers with an empty list, never an error,
  // so the local editor above stays live whatever the network is doing.
  handle('tags.suggest', (request) =>
    tagSuggestions.suggest(assertSuggestTagsRequest(request).trackId)
  )

  // D23 — one grouped, ranked pass over every local entity type. The service
  // owns the ranking so a new searchable kind is not another round trip to
  // debounce, and reaches no socket: the palette's finder is local.
  handle('search.query', (request) => search.query(assertSearchQuery(request)))

  // D25/D26 — albums by arrival for the Quick Menu's Recent Additions, a short
  // capped list computed on open rather than a paged collection.
  handle('library.recentlyAddedAlbums', (request) =>
    library.recentlyAddedAlbums(assertRecentlyAddedAlbumsRequest(request).limit)
  )

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

  handle('discover.shelves', () => library.discoverShelves())

  handle('discover.saveShelf', async (request) => {
    const { recipeId } = assertSaveDiscoverShelfRequest(request)
    const snapshot = await library.discoverSaveShelf(recipeId)
    const playlist = await playlists.create(snapshot.name)
    if (snapshot.trackIds.length === 0) return playlist
    return playlists.addTracks({
      playlistId: playlist.id,
      trackIds: snapshot.trackIds,
      insertion: { at: 'end' }
    })
  })

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

  handle('podcasts.cancelDownload', (request) => {
    const { episodeId } = assertRecord(request, 'request')
    return podcasts.cancelDownload(assertPositiveInt(episodeId, 'episodeId'))
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
      throw new OscineError('invalid-request', 'played must be a boolean.')
    }
    return podcasts.setPlayed(assertPositiveInt(episodeId, 'episodeId'), played)
  })

  handle('podcasts.setAutoDownload', (request) => {
    const { podcastId, enabled } = assertRecord(request, 'request')
    if (typeof enabled !== 'boolean') {
      throw new OscineError('invalid-request', 'enabled must be a boolean.')
    }
    return podcasts.setAutoDownload(assertPositiveInt(podcastId, 'podcastId'), enabled)
  })

  handle('podcasts.setKeepLast', (request) => {
    const { podcastId, keepLast } = assertRecord(request, 'request')
    return podcasts.setKeepLast(
      assertPositiveInt(podcastId, 'podcastId'),
      assertPositiveInt(keepLast, 'keepLast')
    )
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

  handle('net.cancelScope', (request) =>
    net.cancelScope(assertCancelNetScopeRequest(request).scope)
  )

  handle('scrobble.status', () => scrobbleStatus.status())

  // D19's rule, at the only place it could be broken: what leaves here is
  // whatever `authorize` resolved with, which the contract guarantees carries a
  // username and a boolean and no credential. There is nothing to strip, and
  // that is deliberate — a handler that had to remember to strip something is a
  // handler that eventually forgets.
  //
  // This one can sit unresolved for minutes while the operator is in their
  // browser. That is the design, not a hang: see `scrobble.connect`.
  handle('scrobble.connect', (request) =>
    scrobble.connect(assertScrobbleTargetRequest(request).target)
  )

  handle('scrobble.cancelConnect', (request) => {
    scrobble.cancelConnect(assertScrobbleTargetRequest(request).target)
    return null
  })

  // The queue is not touched. Whatever is waiting for this target stays waiting,
  // and the pane says so — those rows are listens that happened, and a
  // disconnect the operator is trying out should not be the gesture that
  // destroys them.
  handle('scrobble.disconnect', async (request) => {
    await scrobble.disconnect(assertScrobbleTargetRequest(request).target)
    return scrobbleStatus.status()
  })

  handle('scrobble.retry', () => scrobbleStatus.retry())

  // Null rather than a `not-found` throw, for `library.getRelated`'s reason: the
  // seed is whatever is playing, and a track with no artist credit is an
  // ordinary library, not an error.
  handle('artist.resolve', (request) => artists.resolve(assertResolveArtistQuery(request).trackId))

  handle('artist.searchCandidates', (request) =>
    artists.searchCandidates(assertSearchArtistCandidatesRequest(request).artistId)
  )

  handle('artist.setMbid', (request) => {
    const { artistId, mbid } = assertSetArtistMbidRequest(request)
    return artists.setMbid(artistId, mbid)
  })

  handle('artist.clearMbid', (request) =>
    artists.clearMbid(assertClearArtistMbidRequest(request).artistId)
  )

  // An artist with no article is an ordinary result rather than a `not-found`
  // throw, which is what lets the pane render an empty state instead of an
  // error. See the channel's own note in the contract.
  handle('artist.biography', (request) =>
    biographies.get(assertGetArtistBiographyRequest(request).artistId)
  )

  // Same shape, same reason: an artist MusicBrainz records no connections for is
  // an empty state rather than an error, and an unresolved one never reaches a
  // socket at all.
  handle('artist.relations', (request) =>
    relations.get(assertGetArtistRelationsRequest(request).artistId)
  )

  // And again for the photograph, which has one more ordinary way of being
  // absent than the other two: a Commons file that no longer exists, or one the
  // artwork processor could not decode. Both are "no picture", not an error.
  handle('artist.image', (request) => images.get(assertGetArtistImageRequest(request).artistId))

  // The url-rels half of the same document `artist.relations` reads. An artist
  // MusicBrainz records no outbound URLs for is an empty state rather than an
  // error, and an unresolved one never reaches a socket at all.
  handle('artist.links', (request) => links.get(assertGetArtistLinksRequest(request).artistId))

  assertEveryChannelHandled()
}

export { emit, setTrustedRendererUrl } from './registry'
