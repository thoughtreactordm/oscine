import type {
  ArtistResolution,
  ClearArtistMbidRequest,
  ResolveArtistQuery,
  SearchArtistCandidatesRequest,
  SetArtistMbidRequest
} from './artist'
import type { ArtistLinksResult, GetArtistLinksRequest } from './artistLinks'
import type { ArtistRelationsResult, GetArtistRelationsRequest } from './artistRelations'
import type { ArtistBiographyResult, GetArtistBiographyRequest } from './biography'
import type { ArtistImageResult, GetArtistImageRequest } from './artistImage'
import type {
  ArtistFavoriteStateRequest,
  ArtistFavoriteStateResult,
  ArtistFavoritesQuery,
  ArtistFavoritesResult,
  FavoriteState,
  FavoriteStateRequest,
  FavoriteStateResult,
  ListFavoriteArtistsQuery,
  ListFavoriteArtistsResult,
  ListFavoriteIdsQuery,
  ListFavoriteIdsResult,
  ListFavoritePlaylistsQuery,
  ListFavoritePlaylistsResult,
  ListFavoritesQuery,
  ListFavoritesResult,
  PlaylistFavoriteStateRequest,
  PlaylistFavoriteStateResult,
  RemoveFavoritesRequest,
  RemoveFavoritesResult,
  ToggleArtistFavoriteRequest,
  TogglePlaylistFavoriteRequest,
  ToggleFavoriteRequest
} from './favorites'
import type {
  AddTagsRequest,
  RemoveTagRequest,
  RemoveTagResult,
  RenameTagRequest,
  SuggestTagsRequest,
  Tag,
  TagSummary,
  TagSuggestion,
  TrackTagsRequest,
  TrackTagView
} from './tags'
import type { AlbumCard } from './albums'
import type { SearchQuery, SearchResult } from './search'
import type { ListPlayHistoryQuery, PlayEntry } from './history'
import type { ListenCommit, RecordListenRequest } from './listens'
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
import type { CancelNetScopeRequest, CancelNetScopeResult, NetResult } from './net'
import type {
  ScrobbleConnection,
  ScrobbleStatusResult,
  ScrobbleTargetRequest,
  ScrobbleTargetStatus
} from './scrobble'
import type { RelatedQuery, RelatedResult } from './related'
import type { DiscoverShelvesResult, SaveDiscoverShelfRequest } from './discover'
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
import type {
  RebuildCountersResult,
  StatsOverTimeQuery,
  StatsOverTimeResult,
  StatsQuery,
  StatsQueryResult,
  StatsSummary,
  StatsSummaryQuery
} from './stats'

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
  /** Controls for Oscine's frameless application window. */
  'window.minimize': { request: null; response: null }
  'window.toggleMaximize': { request: null; response: boolean }
  'window.isMaximized': { request: null; response: boolean }
  'window.close': { request: null; response: null }
  /** The running application version, for the About dialog. */
  'app.getVersion': { request: null; response: string }
  /**
   * Opens an `http`/`https` URL in the system browser. Any other scheme is
   * refused in main — the renderer has no path to the shell of its own, and the
   * Help and Open Source links are the only reason this exists.
   */
  'app.openExternal': { request: { url: string }; response: null }
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
   *
   * `favorites` is W10-9's bias and is optional in the strict sense: omitting it
   * gives the same answer this channel gave before the field existed. See
   * `FavoriteBias` for what the other two values promise.
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
   * Resolves a track id to an opaque `oscine://track/<id>` URL the renderer can
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
   * Commits one listen — the whole of D17's write path, in one transaction.
   *
   * Reported at *departure* rather than at threshold-crossing, and only when
   * the threshold was crossed, so the renderer calling this at all is the
   * decision. Everything on the row beyond these three fields is snapshotted in
   * main from library state resolved through `track_overrides`.
   *
   * Resolves `null` when no row was written. Three ordinary causes, none of
   * them a fault: the track left the library while it was playing, it has no
   * title to attribute the listen to, or the identity index already holds it.
   */
  'listens.record': { request: RecordListenRequest; response: ListenCommit | null }
  /**
   * The renderer's answer to `listens.flushRequested`: the in-flight listen has
   * been departed and any write it caused has landed.
   *
   * A channel rather than an ack on the event because `IpcEventContract` is
   * one-way by construction, and quitting is precisely the case where main
   * needs to know the answer arrived — it is about to close the database.
   * Always called, including when there was nothing to flush, so that the
   * common case costs a round trip rather than the timeout.
   */
  'listens.flushed': { request: null; response: null }
  /**
   * Recomputes `tracks.play_count` and `tracks.last_played_at` from `listens`.
   *
   * The repair for the two columns D17 makes caches of the log. Main runs it
   * itself after a migration that touches `listens` and after a D11 import; this
   * channel is the on-demand third, offered in Settings because a cache the
   * operator cannot rebuild is a cache they have to believe.
   *
   * Whole-library and unconditional — there is one definition of what the
   * columns mean, and a cheaper partial repair would be a second one. It writes
   * only the rows that were wrong, so the answer over a healthy database is
   * `tracksChanged: 0` and no writes at all.
   */
  'stats.rebuildCounters': { request: null; response: RebuildCountersResult }
  /**
   * One ranking over the log: a range, a dimension, an order, a page.
   *
   * **One channel, four dimensions.** Top tracks, top albums, top artists and
   * top genres are the same query with a different `GROUP BY`, and four
   * channels would have been four copies of the range predicate, the paging and
   * the tie-break — agreeing on the day they were written and not after.
   *
   * Both totals come back on every row and only the order is asked for, because
   * "most played" means two different things for a library that mixes songs
   * with hour-long mixes and neither is main's to pick. See `StatsSort`.
   *
   * Every row carries a `trackId` where the group still has a surviving track,
   * so a dashboard row clicks through to the library the way every other seeded
   * read in this app does — and `null` where the track is gone, which the UI
   * renders as a row that does not click. A row that no longer resolves is the
   * ordinary state of old history, not an error.
   */
  'stats.query': { request: StatsQuery; response: StatsQueryResult }
  /**
   * The headline numbers over one range — the whole log, or one group in it.
   *
   * Its own channel rather than a fifth dimension, because it is the one answer
   * that is not a ranking: no group, no page, no order — seven scalars. The
   * counts it reports are distinct snapshot groups, deliberately the same
   * numbers the matching rankings report as their `total`, so the headline and
   * the list below it cannot disagree on screen.
   *
   * `scope` is what makes it the Tunedeck's channel as well as the dashboard's.
   * The deck asks the same seven numbers of the listens around the playing
   * track, its album or its artist, which is this query with a narrower `WHERE`
   * — not a bespoke one written beside it. It is a *track id* and a word, and
   * main resolves the snapshot tuple with the same statement the listen commit
   * writes one with; see `StatsScope` for why that direction and not the other.
   *
   * A scope that names no group comes back `resolved: false` rather than as an
   * error or as zeros. "This track has no album" and "you have not played this
   * album" are two sentences, and the surface drawing them needs to be able to
   * tell which one it is holding.
   */
  'stats.summary': { request: StatsSummaryQuery; response: StatsSummary }
  /**
   * Listening over time: a dense series of fixed-width buckets.
   *
   * The buckets are anchored at `range.from` and measured in milliseconds —
   * there is no calendar in main, which is the same decision that makes `range`
   * two integers rather than a preset name. `StatsBucket` says what follows
   * from that, including why there is no `month`.
   *
   * Empty buckets are present with zeros. Omitting them would draw a flat line
   * across a week away from the machine, which is a chart that lies.
   */
  'stats.overTime': { request: StatsOverTimeQuery; response: StatsOverTimeResult }
  /**
   * Flips one track's heart and answers with the state that resulted — **D18**.
   *
   * Returning the state rather than nothing is the whole reason this is one
   * channel instead of a `set(trackId, favorite)`: the renderer holds the same
   * track in a list row, in NowPlaying and possibly in the related pane, and any
   * of them predicting the outcome is a prediction that can be wrong. Main read
   * the table; main says what it says now.
   *
   * A track that left the library between the click and the write comes back
   * `favorite: false`, which is not an error and is the literal truth — a track
   * that is not in the library is not favorited.
   */
  'favorites.toggle': { request: ToggleFavoriteRequest; response: FavoriteState }
  /**
   * Which of these track ids are favorited. One query, whatever the batch size.
   *
   * For the callers that hold ids without having gone through the track
   * projection — a resolved selection, a queue. Anything rendering a `Track`
   * already has `favorite` on the row and must not ask this instead; the point
   * of resolving it in the page query is that the page costs one round trip.
   */
  'favorites.state': { request: FavoriteStateRequest; response: FavoriteStateResult }
  /**
   * The favorites, newest-hearted first. Paged like every other list.
   *
   * Display rows rather than ids, so the pinned rail entry draws through the
   * same component and the same projection the song list does. There is no sort
   * parameter: D18's accepted cost is that this collection has no authored
   * order, and `favorited_at` descending is the one order that needs no
   * explaining.
   */
  'favorites.list': { request: ListFavoritesQuery; response: ListFavoritesResult }
  /**
   * The same window, ids only — what a Shift-range in the rail's pane resolves
   * through, and how "play My Favorites" reads the whole collection.
   *
   * The neighbour of `playlists.listEntryIds`, and separate from
   * `favorites.list` for its reason: a range selection spans rows the pane never
   * loaded, and resolving it must not be able to fill the page cache behind the
   * viewport's back.
   */
  'favorites.listIds': { request: ListFavoriteIdsQuery; response: ListFavoriteIdsResult }
  /**
   * The playing artist's favorites, newest-hearted first — the deck's Favorite
   * Songs pane. Seeded by track, as `library.getRelated` is.
   *
   * Its own channel rather than a filter on `favorites.list`, because the two
   * are different shapes and would have had to pretend otherwise. That one is a
   * window over a collection with a `total` behind a scrollbar; this one is a
   * bounded answer about a subject, capped at `ARTIST_FAVORITES_LIMIT`, and the
   * deck panes are all bounded answers. Merging them would have given the rail
   * an artist filter it never sets and this pane a paging protocol it never
   * uses.
   *
   * **It cannot leave the machine**, which is the property the card turns on:
   * two indexed reads over `tracks` and `track_favorites`, and no mbid anywhere
   * in it. It sits beside `artist.resolve` in the deck and shares nothing with
   * it — deliberately not even the artist id, which is what would have made this
   * pane wait on that one's socket.
   */
  'favorites.byArtist': { request: ArtistFavoritesQuery; response: ArtistFavoritesResult }
  /**
   * Un-favorites a batch, in one transaction.
   *
   * Not a bulk `toggle`: over a selection, "the opposite of what each row holds"
   * is not a gesture anyone makes. Removing a row from the pinned rail entry is
   * un-hearting it — the same fact, said from the other end — so this is what
   * that removal calls, and it says which direction it goes.
   */
  'favorites.remove': { request: RemoveFavoritesRequest; response: RemoveFavoritesResult }
  /**
   * One blended, grouped, ranked pass over every local entity type — the
   * command palette's data side (**D23**). Tracks reuse `tracks_fts`; albums,
   * artists and playlists get lightweight indexing; "shows" are the operator's
   * *subscribed* podcasts matched locally.
   *
   * One channel rather than one per type, so ranking stays on the main side of
   * the wire and a new searchable type is not another round trip to debounce.
   * It never reaches the network — Apple's catalogue stays behind
   * `podcasts.searchCatalog` (D14). Empty groups are omitted; per-group caps and
   * the renderer's prefixes are the two brakes on cross-type ranking (RQ2).
   */
  'search.query': { request: SearchQuery; response: SearchResult }
  /**
   * Flips a playlist's **star** and answers with the favorited subset of the
   * ids it touched — **D24**. The playlist counterpart of `favorites.toggle`,
   * returning state rather than nothing for the same reason: main read the
   * table, main says what it says now, and no star predicts its own click.
   */
  'favorites.togglePlaylist': {
    request: TogglePlaylistFavoriteRequest
    response: PlaylistFavoriteStateResult
  }
  /** Which of these playlist ids are starred — the batch star lookup. */
  'favorites.playlistState': {
    request: PlaylistFavoriteStateRequest
    response: PlaylistFavoriteStateResult
  }
  /**
   * The Quick Menu's Favorite Playlists list — starred playlists,
   * `favorited_at` descending, capped (**D26**). Short and computed on open,
   * not a paged collection.
   */
  'favorites.listPlaylists': {
    request: ListFavoritePlaylistsQuery
    response: ListFavoritePlaylistsResult
  }
  /** The artist star, mirroring `favorites.togglePlaylist` (**D24**). */
  'favorites.toggleArtist': {
    request: ToggleArtistFavoriteRequest
    response: ArtistFavoriteStateResult
  }
  /** Which of these artist ids are starred — the batch star lookup. */
  'favorites.artistState': {
    request: ArtistFavoriteStateRequest
    response: ArtistFavoriteStateResult
  }
  /**
   * The Quick Menu's Favorite Artists list — starred artists, `favorited_at`
   * descending, capped (**D26**). Returns the real favorited artists, not the
   * track-by-artist set the existing `artistFavorites` store holds.
   */
  'favorites.listArtists': {
    request: ListFavoriteArtistsQuery
    response: ListFavoriteArtistsResult
  }
  /**
   * The tag vocabulary with a live per-tag count — **W15**. Unpaged: this is the
   * browse-by-tag column's whole content, and a vocabulary is small by nature (a
   * person coins tags, they do not accrue). Ordered by display spelling in the
   * store, so the column reads alphabetically however each tag was capitalised.
   */
  'tags.list': { request: null; response: TagSummary[] }
  /**
   * One track's two vocabularies, kept apart — file genres and user tags.
   *
   * A track with neither, or one not in the library at all, comes back two empty
   * lists rather than an error: "no tags" is an ordinary answer, and the deck
   * pane that reads this draws the same nothing for both.
   */
  'tags.forTrack': { request: TrackTagsRequest; response: TrackTagView }
  /**
   * Applies one label to a batch of tracks, coining the vocabulary row if new,
   * and answers with that row — **W15**.
   *
   * Returns the `Tag` rather than nothing for `favorites.toggle`'s reason: the
   * renderer holds the same tag in a column, a deck pane and the tracks it just
   * tagged, and only main knows the id and key it minted. Handing back the row
   * lets every one of them redraw from the same truth instead of predicting it.
   * `null` only if the label normalised away to nothing, which the validate
   * layer already refuses — so a caller past the seam can read it as the row.
   */
  'tags.add': { request: AddTagsRequest; response: Tag | null }
  /**
   * Removes one tag from a batch of tracks, in one transaction. Emptying a tag's
   * last assignment prunes it — `pruned` says so, and the vocabulary column drops
   * it without re-reading `tags.list`.
   */
  'tags.remove': { request: RemoveTagRequest; response: RemoveTagResult }
  /**
   * Re-spells one vocabulary row and answers with the surviving one.
   *
   * The store resolves a rename into a correction, a rename, or a merge into an
   * existing tag that shares the new key; the renderer sends id and label and
   * redraws from what returns rather than guessing which of the three happened.
   */
  'tags.rename': { request: RenameTagRequest; response: Tag | null }
  /**
   * Tags the operator might want for a track — **W15**, stubbed here.
   *
   * Declared now so the renderer store is complete against the full surface, but
   * it returns an empty list until the MusicBrainz card lands: this build fetches
   * nothing, and D14's "nothing leaves the machine except from main" is not
   * bent by a channel that never opens a socket.
   */
  'tags.suggest': { request: SuggestTagsRequest; response: TagSuggestion[] }
  /**
   * The Quick Menu's Recent Additions — albums by arrival, newest first
   * (**D25/D26**). Ordered by `MAX(indexed_at)` over each album's tracks, never
   * by `mtime`. A bare array capped by `limit`: a short drawer list, not a
   * windowed collection, and it is not D18's "Recently Added" trigger firing —
   * it is a computed, ephemeral view recomputed on open.
   */
  'library.recentlyAddedAlbums': { request: { limit: number }; response: AlbumCard[] }
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
  /**
   * Today's Discover shelves — named local recipes over the library and the
   * listens log (**D20**).
   *
   * Empty request: the clock is main's. Tests call compose with `nowMs` directly
   * and do not go through this channel for determinism. `null` rather than
   * `void`, like every other empty request in this map — structured clone has
   * one unambiguous empty value.
   *
   * Not `podcasts.recommend`. That one reaches Apple. This one does not leave
   * the machine, and a library with no listens answers with whatever recipes
   * do not need a taste seed — often just `unplayed` — rather than with an
   * error.
   *
   * There is no `discover.playShelf`. Playing is a renderer gesture over item
   * ids the pane already has.
   */
  'discover.shelves': { request: null; response: DiscoverShelvesResult }
  /**
   * Snapshot one shelf from the last `discover.shelves` result as a playlist.
   *
   * The last result, not a re-query: the operator is saving what they are
   * looking at. Album items expand to tracks in disc/track/id order; the name
   * is `{shelf.title} · {dayKey}`. An ordinary D12 row — editing it later does
   * not edit the recipe, and reopening Discover tomorrow does not edit the
   * playlist.
   */
  'discover.saveShelf': { request: SaveDiscoverShelfRequest; response: Playlist }
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
  /** Aborts a download in progress; the episode returns to remote (idle). */
  'podcasts.cancelDownload': { request: { episodeId: number }; response: Episode }
  /** Removes the local file; the episode remains listed as remote. */
  'podcasts.deleteDownload': { request: { episodeId: number }; response: Episode }
  /** Removes every local file for a show; the subscription remains. */
  'podcasts.clearDownloads': { request: { podcastId: number }; response: Podcast }
  'podcasts.setPlayed': {
    request: { episodeId: number; played: boolean }
    response: Episode
  }
  /** Toggle auto-download of new episodes for a show (P4). */
  'podcasts.setAutoDownload': {
    request: { podcastId: number; enabled: boolean }
    response: Podcast
  }
  /** Set how many auto-downloaded episodes a show retains (P4). */
  'podcasts.setKeepLast': {
    request: { podcastId: number; keepLast: number }
    response: Podcast
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

  /**
   * Which scrobbling accounts are connected, and how their outbox is doing
   * (**D19**).
   *
   * The response is the whole of what the renderer is ever told about a
   * scrobbling credential: a target, two booleans, a username. Not the session
   * key, not a token, not an expiry — there is nothing in it a compromised
   * renderer could scrobble with, which is why the credential's storage is a
   * main-process file and not a settings row.
   *
   * The queue depth and last error ride along because the pane draws them
   * beside the username, and a separate channel for them would be two round
   * trips that can disagree — the account reading connected while the count
   * still describes the session before it.
   */
  'scrobble.status': { request: null; response: ScrobbleStatusResult }

  /**
   * Begin a target's sign-in, and resolve when it is over.
   *
   * A long call by design: Last.fm's is a round trip through the operator's own
   * browser, so this can sit unresolved for minutes. That is why it is `invoke`
   * rather than a fire-and-forget with a completion event — the pane's waiting
   * state is exactly the lifetime of this promise, and there is no third state
   * to get out of step.
   *
   * Failures come back as `NetResult` rather than as a thrown IPC error,
   * because most of them are things to *show* — no application key configured,
   * no keyring on this machine, the operator closed the tab. A pane that has to
   * `try` around a sign-in will render a blank where an explanation belongs.
   */
  'scrobble.connect': { request: ScrobbleTargetRequest; response: NetResult<ScrobbleConnection> }

  /**
   * Abandon a sign-in in progress — the way out for an operator who opened the
   * browser and changed their mind.
   *
   * Its own channel rather than a reuse of `net.cancelScope`, which would also
   * abandon an unrelated drain: closing a login tab is not a reason to drop a
   * batch of scrobbles that happens to be in flight.
   */
  'scrobble.cancelConnect': { request: ScrobbleTargetRequest; response: null }

  /**
   * Forget a target's credential. Idempotent.
   *
   * Deletes Oscine's copy of the session key, which is all Oscine can do:
   * revoking it belongs to the operator, on their account's applications page,
   * and an app that claimed to have revoked something it merely forgot would be
   * lying about the more important half.
   *
   * Queued scrobbles for the target are **kept**, and the pane says so. They are
   * listens that actually happened; reconnecting the same account sends them,
   * and a disconnect that silently emptied the queue would destroy data on a
   * gesture the operator is likely to be making experimentally.
   */
  'scrobble.disconnect': { request: ScrobbleTargetRequest; response: ScrobbleStatusResult }

  /**
   * Drain now — the button beside a queue that is not moving.
   *
   * A courtesy rather than a mechanism: enqueue, app start, network return and
   * a five-minute backstop already wake the worker, so this exists for the
   * operator who has just plugged the ethernet back in and would like to watch
   * the number fall rather than take it on faith. Resolves with the status the
   * pass left behind, so the count the pane draws next is the post-drain one.
   *
   * Never rejects. A pass that failed is a `lastError` in the response, which is
   * the same thing the pane was already drawing.
   */
  'scrobble.retry': { request: null; response: ScrobbleStatusResult }

  /**
   * Who is playing, as an identity rather than as a tag string (**R5**).
   *
   * `null` when the track has no artist credit, or has left the library while
   * the deck was looking at it — the same race `library.getRelated` answers with
   * `null` for, and the same reason it is not an error.
   *
   * Searches only when the `artists` row carries no decision yet. An artist
   * matched once is answered from the database on every later play, which is the
   * whole purpose of the MBID column.
   */
  'artist.resolve': {
    request: ResolveArtistQuery
    response: ArtistResolution | null
  }

  /**
   * The disambiguation picker's list, fetched because the operator asked to see
   * it rather than because something is playing.
   *
   * Separate from `resolve` so that an artist whose identity is settled costs no
   * request until somebody disagrees with it. Adopts nothing: the answer is a
   * list, and choosing from it is `artist.setMbid`.
   */
  'artist.searchCandidates': {
    request: SearchArtistCandidatesRequest
    response: ArtistResolution
  }

  /**
   * The operator's choice, which is authoritative and durable — **D7**'s
   * treatment of a tag correction, applied to an identity.
   *
   * `mbid: null` is "none of these", which is a decision and not an absence: it
   * is stored, it survives restart, and it stops the automatic matcher asking
   * again. Nothing automatic ever overwrites the result.
   */
  'artist.setMbid': {
    request: SetArtistMbidRequest
    response: ArtistResolution
  }

  /** Drops a correction so automatic matching resumes, and re-resolves at once. */
  'artist.clearMbid': {
    request: ClearArtistMbidRequest
    response: ArtistResolution
  }

  /**
   * The artist's biography, by way of Wikidata and Wikipedia (**D14**).
   *
   * Keyed on the artist rather than on an MBID, so the identifier the two hops
   * start from is the one on the `artists` row rather than one the renderer
   * supplied. A correction made in the picker therefore changes which biography
   * this answers with, and a renderer that has gone stale cannot ask for a
   * biography belonging to an artist the operator has already overruled.
   *
   * Never throws for a missing article: an artist with no Wikidata item, or with
   * an item carrying no article in any language we asked for, comes back as
   * `none`. That is the ordinary state of a great many artists and not a fault.
   */
  'artist.biography': {
    request: GetArtistBiographyRequest
    response: ArtistBiographyResult
  }

  /**
   * Who the artist is connected to, intersected with what the library holds.
   *
   * Keyed on the artist for `artist.biography`'s reason, and the consequence
   * here is sharper: the response is a *graph*, and a graph drawn for an
   * identity the renderer guessed at would be a confident, detailed and entirely
   * wrong account of somebody else's band.
   *
   * The MusicBrainz half is cached under **D14**; the library half is not, and
   * is recomputed on every call. Ownership changes whenever a folder is scanned,
   * and a cached intersection would be stale in the most visible way there is.
   *
   * Never throws for an artist with no relations: a solo artist MusicBrainz
   * records no connections for comes back as `none`, which is the ordinary state
   * of a great many artists and not a fault.
   */
  'artist.relations': {
    request: GetArtistRelationsRequest
    response: ArtistRelationsResult
  }

  /**
   * The artist's photograph, by way of Wikidata's P18 claim and Commons.
   *
   * Keyed on the artist for `artist.biography`'s reason. What comes back is not
   * the picture: it is two `oscine://artwork/…` routes into the same
   * content-hashed thumbnail cache album art lives in, plus the credit Commons
   * requires be shown with it. The bytes never cross this boundary, and the
   * renderer never learns where they are on disk.
   *
   * Never throws for a missing picture. An artist with no Wikidata item, an item
   * with no image claim, a file deleted from Commons since the claim was made,
   * and bytes the artwork processor could not decode all come back as `none` —
   * which is the ordinary state of most of a library.
   */
  'artist.image': {
    request: GetArtistImageRequest
    response: ArtistImageResult
  }

  /**
   * Where the artist is on the web — homepage, Bandcamp, purchase and socials.
   *
   * Keyed on the artist for `artist.biography`'s reason, and the `url-rels` half
   * of the same MusicBrainz document `artist.relations` reads the `artist-rels`
   * half of. Cached under **D14**; the response carries only http/https URLs,
   * validated at the parse, because each one is handed to `app.openExternal` and
   * never to a `BrowserWindow` — this app has no in-app view of third-party pages.
   *
   * Never throws for an artist with no links: a page that records no outbound
   * URLs comes back as `none`, which is ordinary and not a fault.
   */
  'artist.links': {
    request: GetArtistLinksRequest
    response: ArtistLinksResult
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
  /**
   * Quit is under way: depart the in-flight listen now.
   *
   * The accumulator lives in the renderer and holds the only copy of a listen
   * in progress, so a quit with a track playing would otherwise lose one that
   * had already earned its row. Main sends this and waits for `listens.flushed`
   * before it closes the database.
   *
   * A hard kill still loses it. That is the accepted cost of the one-write
   * design, and it is cheaper than the alternative: writing an in-flight listen
   * durably means a heartbeat into SQLite every few seconds for the entire life
   * of the app, to protect a single row.
   */
  'listens.flushRequested': null
  /**
   * A scrobbling account connected or disconnected, or its queue moved
   * (**D19**).
   *
   * `scrobble.connect` already resolves with the new connection, so this is not
   * how the pane that started a sign-in learns it succeeded. It is how every
   * *other* view learns — and how the pane learns about the two changes nobody
   * is holding a promise for: a session key Last.fm has stopped accepting,
   * which stands the account down from inside the drain worker, and a queue
   * that grew because a listen committed offline or shrank because a pass got
   * through.
   *
   * Emitted once per drain pass rather than per row, which is what makes it
   * affordable to send on a schedule the operator never asked for.
   */
  'scrobble.statusChanged': ScrobbleTargetStatus[]
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
  'app.getVersion',
  'app.openExternal',
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
  'listens.record',
  'listens.flushed',
  'stats.rebuildCounters',
  'stats.query',
  'stats.summary',
  'stats.overTime',
  'favorites.toggle',
  'favorites.state',
  'favorites.list',
  'favorites.listIds',
  'favorites.byArtist',
  'favorites.remove',
  'search.query',
  'favorites.togglePlaylist',
  'favorites.playlistState',
  'favorites.listPlaylists',
  'favorites.toggleArtist',
  'favorites.artistState',
  'favorites.listArtists',
  'tags.list',
  'tags.forTrack',
  'tags.add',
  'tags.remove',
  'tags.rename',
  'tags.suggest',
  'library.recentlyAddedAlbums',
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
  'discover.shelves',
  'discover.saveShelf',
  'podcasts.list',
  'podcasts.get',
  'podcasts.subscribe',
  'podcasts.unsubscribe',
  'podcasts.refresh',
  'podcasts.refreshAll',
  'podcasts.listEpisodes',
  'podcasts.listRecent',
  'podcasts.downloadEpisode',
  'podcasts.cancelDownload',
  'podcasts.deleteDownload',
  'podcasts.clearDownloads',
  'podcasts.setPlayed',
  'podcasts.setAutoDownload',
  'podcasts.setKeepLast',
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
  'net.cancelScope',
  'scrobble.status',
  'scrobble.connect',
  'scrobble.cancelConnect',
  'scrobble.disconnect',
  'scrobble.retry',
  'artist.resolve',
  'artist.searchCandidates',
  'artist.setMbid',
  'artist.clearMbid',
  'artist.biography',
  'artist.relations',
  'artist.image',
  'artist.links'
] as const satisfies readonly IpcChannel[]

export const IPC_EVENT_CHANNELS = [
  'window.maximizedChange',
  'library.scanProgress',
  'library.notice',
  'library.replayGainProgress',
  'podcasts.downloadProgress',
  'settings.changed',
  'listens.flushRequested',
  'scrobble.statusChanged'
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
export const TRACK_SCHEME = 'oscine'

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

/** The `oscine:` hostname that proxies remote catalogue thumbnails. */
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
