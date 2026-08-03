import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { FermataError, podcasts as podcastsApi } from '@renderer/ipc'
import { episodeAsTrack } from '@renderer/playback/episodeTrack'
import { restoredTabSession, useViewSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import {
  episodeIdFromPlaybackTrackId,
  episodePlaybackTrackId,
  type Episode,
  type EpisodeDownloadProgress,
  type Podcast,
  type PodcastCatalogHit,
  type PodcastRecommendShelf
} from '@shared/podcasts'
import type { TabSession } from '@shared/settings'

/** Fixture tab at the left of the strip — Discover pods. */
export const PODCAST_DISCOVER_TAB = null

/**
 * Open show tabs — workspace state, like the playlist strip.
 *
 * Closing a show tab does not unsubscribe; the subscription rail is where
 * closed shows live. A scroll target is never restored, which is why
 * `focusEpisodeId` is a plain ref here and not part of the stored shape: it is
 * a one-shot instruction to the show pane, and restoring one would yank the
 * list on launch.
 */
export const PODCAST_TABS_KEY = 'view.podcastTabs'

/**
 * Subscriptions, open show tabs, and the recent episode feed.
 *
 * Mirrors the Curate playlists store: `list` is every subscription, `openIds`
 * is workspace, `viewedPodcastId` is which show (or Discover) is on screen.
 */
export const usePodcastsStore = defineStore('podcasts', () => {
  const list = ref<Podcast[]>([])
  const recent = ref<Episode[]>([])
  const recentTotal = ref(0)
  const episodesByPodcast = ref<Map<number, Episode[]>>(new Map())
  const episodeTotals = ref<Map<number, number>>(new Map())
  const viewedPodcastId = ref<number | null>(null)
  const focusEpisodeId = ref<number | null>(null)
  const notice = ref<string | null>(null)
  const loading = ref(false)
  const refreshing = ref(false)
  const subscribing = ref(false)
  const searchingCatalog = ref(false)
  const catalogHits = ref<PodcastCatalogHit[]>([])
  const recommending = ref(false)
  const recommendShelves = ref<PodcastRecommendShelf[]>([])
  /** Shelves are generic popular charts because there are no subscriptions yet. */
  const coldStart = ref(false)
  const activeCategoryId = ref<string | null>(null)
  const categoryHits = ref<PodcastCatalogHit[]>([])
  const browsingCategory = ref(false)
  let categoryGeneration = 0
  const downloadProgress = ref<Map<number, EpisodeDownloadProgress>>(new Map())

  const settings = useViewSettings()
  // Gated by `view.restoreSession`. The gate is on this read only; the watcher
  // below goes on recording whatever ends up open. See `restoredTabSession`.
  const restored = restoredTabSession(settings, PODCAST_TABS_KEY)
  const openIds = ref<number[]>(restored.openIds)
  // Narrowed rather than widened: `TabStop` admits the pinned fixtures Curate's
  // strip has, and this strip declares none — so its validator cannot produce
  // one and there is no case being dropped here, only the type catching up.
  viewedPodcastId.value = typeof restored.viewedId === 'number' ? restored.viewedId : null

  const byId = (podcastId: number): Podcast | null =>
    list.value.find((podcast) => podcast.id === podcastId) ?? null

  const openTabs = computed<Podcast[]>(() =>
    openIds.value.map(byId).filter((podcast): podcast is Podcast => podcast !== null)
  )

  const viewed = computed(() =>
    viewedPodcastId.value === null ? null : byId(viewedPodcastId.value)
  )

  watch(
    [openIds, viewedPodcastId],
    () => {
      settings.set<TabSession>(PODCAST_TABS_KEY, {
        openIds: openIds.value,
        viewedId: viewedPodcastId.value
      })
    },
    { deep: true }
  )

  async function refresh(): Promise<void> {
    loading.value = true
    notice.value = null
    try {
      list.value = await podcastsApi.list()
      openIds.value = openIds.value.filter((id) => byId(id) !== null)
      if (viewedPodcastId.value !== null && byId(viewedPodcastId.value) === null) {
        viewedPodcastId.value = PODCAST_DISCOVER_TAB
      }
      await refreshRecent()
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not load podcasts.'
    } finally {
      loading.value = false
    }
  }

  async function refreshRecent(): Promise<void> {
    const result = await podcastsApi.listRecent({ offset: 0, limit: 50 })
    recent.value = result.episodes
    recentTotal.value = result.total
  }

  async function loadEpisodes(podcastId: number): Promise<void> {
    const result = await podcastsApi.listEpisodes({ podcastId, offset: 0, limit: 100 })
    const next = new Map(episodesByPodcast.value)
    next.set(podcastId, result.episodes)
    episodesByPodcast.value = next
    const totals = new Map(episodeTotals.value)
    totals.set(podcastId, result.total)
    episodeTotals.value = totals
  }

  function openTab(podcastId: number, episodeId?: number): void {
    if (!openIds.value.includes(podcastId)) {
      openIds.value = [...openIds.value, podcastId]
    }
    viewedPodcastId.value = podcastId
    focusEpisodeId.value = episodeId ?? null
    void loadEpisodes(podcastId).catch((error: unknown) => {
      notice.value = error instanceof FermataError ? error.message : 'Could not load episodes.'
    })
  }

  function view(podcastId: number | null): void {
    viewedPodcastId.value = podcastId
    focusEpisodeId.value = null
    if (podcastId !== null) {
      void loadEpisodes(podcastId).catch((error: unknown) => {
        notice.value = error instanceof FermataError ? error.message : 'Could not load episodes.'
      })
    }
  }

  function close(podcastId: number): void {
    const index = openIds.value.indexOf(podcastId)
    if (index < 0) return
    const next = openIds.value.filter((id) => id !== podcastId)
    openIds.value = next
    if (viewedPodcastId.value === podcastId) {
      const neighbour = next[index] ?? next[index - 1] ?? PODCAST_DISCOVER_TAB
      viewedPodcastId.value = neighbour
    }
  }

  function clearFocusEpisode(): void {
    focusEpisodeId.value = null
  }

  async function subscribe(feedUrl: string): Promise<Podcast | null> {
    subscribing.value = true
    notice.value = null
    try {
      const podcast = await podcastsApi.subscribe(feedUrl)
      list.value = await podcastsApi.list()
      await refreshRecent()
      openTab(podcast.id)
      return podcast
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not subscribe.'
      return null
    } finally {
      subscribing.value = false
    }
  }

  function isSubscribedFeed(feedUrl: string): boolean {
    try {
      const key = new URL(feedUrl).toString()
      return list.value.some((podcast) => {
        try {
          return new URL(podcast.feedUrl).toString() === key
        } catch {
          return podcast.feedUrl === feedUrl
        }
      })
    } catch {
      return list.value.some((podcast) => podcast.feedUrl === feedUrl)
    }
  }

  /**
   * Typing races the network: a slow search for "ra" must not land on top of a
   * finished search for "radiolab". Only the newest generation may write.
   */
  let searchGeneration = 0

  async function searchCatalog(term: string): Promise<void> {
    const q = term.trim()
    const generation = ++searchGeneration
    if (q.length < 2) {
      catalogHits.value = []
      searchingCatalog.value = false
      return
    }
    searchingCatalog.value = true
    notice.value = null
    try {
      const result = await podcastsApi.searchCatalog({ term: q, limit: 20 })
      if (generation !== searchGeneration) return
      catalogHits.value = result.hits
    } catch (error) {
      if (generation !== searchGeneration) return
      catalogHits.value = []
      notice.value = error instanceof FermataError ? error.message : 'Catalogue search failed.'
    } finally {
      if (generation === searchGeneration) searchingCatalog.value = false
    }
  }

  function clearCatalogSearch(): void {
    searchGeneration++
    catalogHits.value = []
    searchingCatalog.value = false
  }

  /**
   * Shelves for Discover. Runs with zero subscriptions too — main answers with
   * popular charts, which is the whole point of a discovery surface.
   */
  async function loadRecommendations(): Promise<void> {
    recommending.value = true
    try {
      const result = await podcastsApi.recommend()
      recommendShelves.value = result.shelves
      coldStart.value = result.coldStart
    } catch (error) {
      recommendShelves.value = []
      notice.value =
        error instanceof FermataError ? error.message : 'Could not load recommendations.'
    } finally {
      recommending.value = false
    }
  }

  /** Selecting the active category again clears it and returns to the shelves. */
  async function browseCategory(genreId: string | null): Promise<void> {
    const next = genreId === activeCategoryId.value ? null : genreId
    activeCategoryId.value = next
    if (next === null) {
      categoryHits.value = []
      return
    }
    const generation = ++categoryGeneration
    browsingCategory.value = true
    try {
      const result = await podcastsApi.browseCategory({ genreId: next })
      if (generation !== categoryGeneration) return
      categoryHits.value = result.hits
    } catch (error) {
      if (generation !== categoryGeneration) return
      categoryHits.value = []
      notice.value = error instanceof FermataError ? error.message : 'Could not load that category.'
    } finally {
      if (generation === categoryGeneration) browsingCategory.value = false
    }
  }

  async function importOpml(xml: string): Promise<void> {
    subscribing.value = true
    notice.value = null
    try {
      const result = await podcastsApi.importOpml(xml)
      list.value = await podcastsApi.list()
      await refreshRecent()
      const failed = result.failed.length
      const ok = result.subscribed.length
      notice.value =
        failed === 0
          ? `Subscribed to ${ok} show${ok === 1 ? '' : 's'}.`
          : `Subscribed to ${ok}; ${failed} feed${failed === 1 ? '' : 's'} failed.`
      if (result.subscribed[0]) openTab(result.subscribed[0].id)
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not import OPML.'
    } finally {
      subscribing.value = false
    }
  }

  async function unsubscribe(podcastId: number): Promise<void> {
    notice.value = null
    try {
      stopIfPlayingPodcast(podcastId)
      await podcastsApi.unsubscribe(podcastId)
      close(podcastId)
      list.value = await podcastsApi.list()
      await refreshRecent()
      episodesByPodcast.value.delete(podcastId)
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not unsubscribe.'
    }
  }

  async function refreshPodcast(podcastId: number): Promise<void> {
    refreshing.value = true
    notice.value = null
    try {
      await podcastsApi.refresh(podcastId)
      list.value = await podcastsApi.list()
      await loadEpisodes(podcastId)
      await refreshRecent()
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not refresh feed.'
    } finally {
      refreshing.value = false
    }
  }

  async function refreshAll(): Promise<void> {
    refreshing.value = true
    notice.value = null
    try {
      list.value = await podcastsApi.refreshAll()
      await refreshRecent()
      if (viewedPodcastId.value !== null) await loadEpisodes(viewedPodcastId.value)
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not refresh feeds.'
    } finally {
      refreshing.value = false
    }
  }

  async function downloadEpisode(episodeId: number): Promise<void> {
    notice.value = null
    try {
      const episode = await podcastsApi.downloadEpisode(episodeId)
      patchEpisode(episode)
      await refreshRecent()
      list.value = await podcastsApi.list()
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Download failed.'
    }
  }

  function stopIfPlayingEpisode(episodeId: number): void {
    const playback = usePlaybackStore()
    if (playback.nowPlaying?.id === episodePlaybackTrackId(episodeId)) {
      playback.stop()
    }
  }

  function stopIfPlayingPodcast(podcastId: number): void {
    const playback = usePlaybackStore()
    const playingId = playback.nowPlaying?.id
    if (playingId === null || playingId === undefined) return
    const episodeId = episodeIdFromPlaybackTrackId(playingId)
    if (episodeId === null) return
    const inShow =
      episodesByPodcast.value.get(podcastId)?.some((episode) => episode.id === episodeId) ?? false
    if (inShow) playback.stop()
  }

  async function deleteDownload(episodeId: number): Promise<void> {
    notice.value = null
    try {
      stopIfPlayingEpisode(episodeId)
      const episode = await podcastsApi.deleteDownload(episodeId)
      patchEpisode(episode)
      await refreshRecent()
      list.value = await podcastsApi.list()
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not remove download.'
    }
  }

  async function clearDownloads(podcastId: number): Promise<void> {
    notice.value = null
    try {
      stopIfPlayingPodcast(podcastId)
      await podcastsApi.clearDownloads(podcastId)
      list.value = await podcastsApi.list()
      await loadEpisodes(podcastId)
      await refreshRecent()
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not clear downloads.'
    }
  }

  /**
   * Ensures the episode is on disk, then plays from that row through the rest
   * of the show's currently loaded list (downloading each remote row as Next
   * would otherwise fail — for this slice only already-ready neighbours join
   * the order, plus the clicked episode after download).
   */
  async function playEpisode(episodeId: number): Promise<void> {
    notice.value = null
    const episode =
      recent.value.find((row) => row.id === episodeId) ??
      [...episodesByPodcast.value.values()].flat().find((row) => row.id === episodeId)
    if (!episode) {
      notice.value = 'That episode is gone.'
      return
    }
    const podcast = byId(episode.podcastId)
    if (!podcast) {
      notice.value = 'That podcast is not in your subscriptions.'
      return
    }

    try {
      let ready = episode
      if (ready.downloadStatus !== 'ready') {
        ready = await podcastsApi.downloadEpisode(episodeId)
        patchEpisode(ready)
        await refreshRecent()
      }

      const showEpisodes = episodesByPodcast.value.get(podcast.id) ?? [ready]
      const start = showEpisodes.findIndex((row) => row.id === episodeId)
      const from = start < 0 ? [ready] : showEpisodes.slice(start)
      const playable = from.filter((row) => row.id === episodeId || row.downloadStatus === 'ready')
      const tracks = playable.map((row) => episodeAsTrack(row, podcast))
      const playback = usePlaybackStore()
      await playback.playTracks({ tracks, index: 0 })
      void setPlayed(episodeId, true)
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not play that episode.'
    }
  }

  async function setPlayed(episodeId: number, played: boolean): Promise<void> {
    try {
      const episode = await podcastsApi.setPlayed(episodeId, played)
      patchEpisode(episode)
      list.value = await podcastsApi.list()
    } catch (error) {
      notice.value = error instanceof FermataError ? error.message : 'Could not update episode.'
    }
  }

  function patchEpisode(episode: Episode): void {
    const listForShow = episodesByPodcast.value.get(episode.podcastId)
    if (listForShow) {
      const next = listForShow.map((row) => (row.id === episode.id ? episode : row))
      const map = new Map(episodesByPodcast.value)
      map.set(episode.podcastId, next)
      episodesByPodcast.value = map
    }
    recent.value = recent.value.map((row) => (row.id === episode.id ? episode : row))
  }

  function applyDownloadProgress(progress: EpisodeDownloadProgress): void {
    const map = new Map(downloadProgress.value)
    map.set(progress.episodeId, progress)
    downloadProgress.value = map
    const listForShow = episodesByPodcast.value.get(progress.podcastId)
    if (listForShow) {
      const next = listForShow.map((row) =>
        row.id === progress.episodeId ? { ...row, downloadStatus: progress.status } : row
      )
      const episodes = new Map(episodesByPodcast.value)
      episodes.set(progress.podcastId, next)
      episodesByPodcast.value = episodes
    }
    recent.value = recent.value.map((row) =>
      row.id === progress.episodeId ? { ...row, downloadStatus: progress.status } : row
    )
  }

  function listenDownloadProgress(): () => void {
    return podcastsApi.onDownloadProgress(applyDownloadProgress)
  }

  return {
    list,
    recent,
    recentTotal,
    episodesByPodcast,
    episodeTotals,
    openIds,
    openTabs,
    viewedPodcastId,
    viewed,
    focusEpisodeId,
    notice,
    loading,
    refreshing,
    subscribing,
    searchingCatalog,
    catalogHits,
    recommending,
    recommendShelves,
    coldStart,
    activeCategoryId,
    categoryHits,
    browsingCategory,
    downloadProgress,
    refresh,
    refreshRecent,
    loadEpisodes,
    openTab,
    view,
    close,
    clearFocusEpisode,
    subscribe,
    isSubscribedFeed,
    searchCatalog,
    clearCatalogSearch,
    browseCategory,
    loadRecommendations,
    importOpml,
    unsubscribe,
    refreshPodcast,
    refreshAll,
    downloadEpisode,
    deleteDownload,
    clearDownloads,
    playEpisode,
    setPlayed,
    listenDownloadProgress
  }
})
