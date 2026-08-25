import { defineStore } from 'pinia'
import { computed, markRaw, ref, watch } from 'vue'
import { library } from '@renderer/ipc'
import { measureLibraryQuery } from '@renderer/metrics'
import { createFacetWindow } from '@renderer/panels/facetWindow'
import { collectPagedIds } from '@renderer/panels/pagedIds'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { useTrackListStore } from '@renderer/stores/trackList'
import {
  isSearchable,
  MAX_TRACK_ID_PAGE,
  MIN_SEARCH_LENGTH,
  plainBrowseFilters,
  type AlbumFacet,
  type ArtistFacet,
  type LibraryBrowseFilters
} from '@shared/library'
import type { FacetDimension } from '@renderer/panels/facetWindow'

const SEARCH_DELAY_MS = 250

/**
 * The library predicate: which root, which search text, which artists and which
 * albums the song list is being narrowed to.
 *
 * All of this was inside `Sources.vue` until the tab row became the router.
 * That made it browse state with a component's lifetime: a look at Now Playing
 * unmounted the sidebar, and coming back re-ran the `immediate` watcher below
 * against a fresh, empty selection — which did not merely forget the user's
 * artists, it wrote the empty predicate over `trackList.filters` and reset the
 * song list too. The state was never scoped to the panel; it only lived there.
 *
 * `Sources` is now a view of this, the way `LibraryView` is already a view of
 * `trackList`. The store is the thin half again: `createFacetWindow` holds the
 * paging, the selection and the eviction, and knows nothing of Pinia or IPC.
 */
export const useBrowseStore = defineStore('browse', () => {
  const roots = useLibraryRootsStore()
  const trackList = useTrackListStore()

  const rootId = ref<number | null>(null)
  const searchInput = ref('')
  const activeSearch = ref<string | null>(null)
  const searchPending = ref(false)

  /**
   * `markRaw`, and it is load-bearing.
   *
   * A Pinia setup store's return value is handed to `reactive`, which unwraps
   * refs all the way down — so a facet window returned plainly would arrive at
   * `FacetList` as an object of numbers and strings where its `FacetWindow`
   * contract says refs. Not a type error to paper over: the panel is written to
   * be handed a window, and a window whose `total` is a snapshot rather than a
   * ref does not track. `markRaw` keeps the object out of the conversion, and
   * every ref inside it stays individually reactive, which is where the
   * reactivity was to begin with.
   */
  const artists = markRaw(
    createFacetWindow<ArtistFacet>({
      dimension: 'artistIds',
      fetchPage: async (query) => {
        const result = await measureLibraryQuery('artists-query', () => library.listArtists(query))
        return { items: result.artists, total: result.total }
      },
      fetchIdPage: (query) => library.listArtistIds(query)
    })
  )
  const albums = markRaw(
    createFacetWindow<AlbumFacet>({
      dimension: 'albumIds',
      fetchPage: async (query) => {
        const result = await measureLibraryQuery('albums-query', () => library.listAlbums(query))
        return { items: result.albums, total: result.total }
      },
      fetchIdPage: (query) => library.listAlbumIds(query)
    })
  )

  /**
   * The three predicates, narrowing left to right.
   *
   * Each pane is filtered by everything above it and never by itself: the
   * artist pane has to keep listing every artist under the root while some of
   * them are selected, or selecting a second one would be impossible.
   */
  const artistFilters = computed<LibraryBrowseFilters>(() => ({
    ...(rootId.value === null ? {} : { rootId: rootId.value }),
    ...(activeSearch.value === null ? {} : { searchText: activeSearch.value })
  }))
  const albumFilters = computed<LibraryBrowseFilters>(() => ({
    ...artistFilters.value,
    ...(artists.filterIds.value === undefined ? {} : { artistIds: artists.filterIds.value })
  }))
  const currentFilters = computed<LibraryBrowseFilters>(() => ({
    ...albumFilters.value,
    ...(albums.filterIds.value === undefined ? {} : { albumIds: albums.filterIds.value })
  }))

  /**
   * `0` is the sentinel for "All folders" in the select, and `null` is the
   * absence of a `rootId` in the filter. Changing it needs no validation of its
   * own: the two panes below are watching, and both prune whatever the narrower
   * root no longer contains.
   */
  const rootValue = computed({
    get: () => rootId.value ?? 0,
    set: (value: number | undefined) => {
      rootId.value = value === undefined || value === 0 ? null : value
    }
  })

  /**
   * Narrowing a pane prunes the selections beneath it.
   *
   * The pruning is what makes a selection safe to keep across a narrowing
   * rather than something to clear defensively. Picking a second artist leaves
   * the albums of the first that they did not both record out of the pane
   * entirely, and an album still filtering the song list from outside the list
   * it was chosen in is a selection the user can neither see nor untick.
   *
   * Only downward. An artist selection is never pruned by an album selection,
   * because the album pane is downstream of it — that direction would let a
   * click in the lower pane silently rewrite the upper one.
   */
  watch(
    artistFilters,
    (filters) => {
      artists.setFilters(filters)
      void artists.pruneSelection()
    },
    { immediate: true }
  )
  watch(
    albumFilters,
    (filters) => {
      albums.setFilters(filters)
      void albums.pruneSelection()
    },
    { immediate: true }
  )

  /**
   * The predicate reaching the song list.
   *
   * `immediate` now fires once, when the store is first used, instead of on
   * every mount of the sidebar. That is the whole point of the move: the tab
   * the user is looking at no longer decides whether the library is filtered.
   */
  watch(
    currentFilters,
    (filters) => {
      trackList.setFilters({ ...filters })
      performance.mark('oscine:library:browse-change')
    },
    { immediate: true }
  )

  /**
   * A finished scan has moved the rows underneath both panes. The counter says
   * so; what to do about it is each list's own business, and this is the
   * facets'. Watched here rather than in the panel, because a scan started from
   * the title bar has to reach the facets whichever tab was showing when it
   * finished — which until now it did not, if that tab was not Library.
   */
  watch(
    () => roots.version,
    () => reloadFacets()
  )

  /**
   * A removed folder cannot go on being the filter.
   *
   * `rootId` outlives the row it names — it is a number in this store, not a
   * reference — so removing the folder the operator had selected would leave
   * every query narrowed to a root that no longer exists. That reads as an
   * empty library rather than as a removed folder, and the select would show a
   * blank because no item matches its value. Falling back to "All folders" is
   * the only honest resting place: the narrowing the operator asked for is
   * genuinely gone.
   *
   * Watches the list rather than `version`, because a removal changes what
   * roots exist without any scan having finished.
   */
  watch(
    () => roots.roots,
    (list) => {
      if (rootId.value === null) return
      if (!list.some((root) => root.id === rootId.value)) rootId.value = null
    }
  )

  let searchTimer: ReturnType<typeof setTimeout> | null = null

  function searchableText(value: string): string | null {
    const trimmed = value.trim()
    return isSearchable(trimmed) ? trimmed : null
  }

  watch(searchInput, () => {
    searchPending.value = true
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      activeSearch.value = searchableText(searchInput.value)
      searchPending.value = false
    }, SEARCH_DELAY_MS)
  })

  const searchHelp = computed(() =>
    searchInput.value.trim() && !searchableText(searchInput.value)
      ? `Enter at least ${MIN_SEARCH_LENGTH} characters in one word to search.`
      : undefined
  )

  function reloadFacets(): void {
    artists.reload()
    albums.reload()
  }

  /**
   * Narrows the library to one artist, named from outside the sidebar.
   *
   * W7-11's second acceptance criterion: an artist the relations pane found in
   * your library has to be openable, and "open" in this app means the song list
   * filtered to them. The deck knows an `artistId` and nothing else — it has
   * never seen the facet pane, does not know whether the artist is on the loaded
   * page, and must not have to.
   *
   * ## Why the narrowing above it is cleared
   *
   * Both the root and the search, and this is the part worth arguing about. A
   * reveal that respected the current predicate would silently do nothing
   * whenever the artist happens to sit outside it — the selection would be
   * written, `pruneSelection` would drop it on the next tick because main
   * reports it as not present, and the operator would have clicked a row and
   * watched the library not change. Failing invisibly is the one outcome worse
   * than either alternative, so the request wins over the filter: asking to see
   * an artist is asking to see them.
   *
   * The album selection goes with it. It is downstream, it was chosen against a
   * different artist, and leaving it would filter the song list by albums the
   * revealed artist did not record — which is an empty list wearing the costume
   * of a working one.
   */
  function revealArtist(artistId: number): void {
    rootId.value = null
    searchInput.value = ''
    activeSearch.value = null
    searchPending.value = false

    albums.clearSelection()
    artists.selectOnlyId(artistId)
  }

  /**
   * Narrows the library to a phrase, named from outside the sidebar.
   *
   * `revealArtist`'s neighbour, and it clears the same things above it for the
   * same reason: a reveal that respected the current predicate would silently do
   * nothing whenever the target sits outside it, and failing invisibly is the one
   * outcome worse than either alternative. Asking to see something is asking to
   * see it.
   *
   * The two are separate verbs rather than one, because they carry different
   * kinds of certainty. `revealArtist` names a row in the facet pane and is
   * exact. This names *text*, and the Listening dashboard sends it because the
   * thing it has to reveal — a snapshot of how an artist was tagged the day you
   * played them — is not a facet id and cannot honestly be resolved into one
   * (see `revealTextFor`). Putting the phrase in the search box is what makes
   * the approximation visible and editable rather than hidden inside a query.
   *
   * `activeSearch` is set here rather than left to the debounce, because nobody
   * is typing: the phrase arrived whole. The watcher still fires and still
   * re-settles on the same value 250 ms later, which changes nothing except a
   * brief spinner — cheaper than a second path into the same state.
   */
  function revealSearch(text: string): void {
    rootId.value = null
    artists.clearSelection()
    albums.clearSelection()

    searchInput.value = text
    activeSearch.value = searchableText(text)
    searchPending.value = false
  }

  /**
   * The predicate a facet row — or a selection of them — stands for.
   *
   * The one *above* the pane, never the one below it. Right-clicking or
   * double-clicking an artist means their tracks under the current root and
   * search, and not narrowed by whatever albums happen to be ticked in the pane
   * underneath — the album pane is downstream, and letting it filter here would
   * make an artist row mean something different depending on a selection in
   * another list. It is the same rule `artistFilters` and `albumFilters`
   * already state for what each pane *lists*, pointed at what a row *contains*.
   *
   * The dimension's own selection is replaced rather than merged, because the
   * gesture is about the rows that were clicked and those are not always the
   * rows that are selected — see `TrackList`'s "act on the selection, or on this
   * row" rule, which the facet panes now share.
   *
   * Separate from `facetTrackIds` because the two verbs want the same predicate
   * in different shapes: the queue verbs want the ids it matches, and playing
   * wants the predicate itself, so that a `PlayOrder` can resolve one position
   * at a time the way a click in the song list does. Two derivations of the
   * same rule would be one to forget.
   */
  function facetFilters(
    dimension: FacetDimension,
    facetIds: readonly number[]
  ): LibraryBrowseFilters {
    const upstream = dimension === 'artistIds' ? artistFilters.value : albumFilters.value
    return plainBrowseFilters({ ...upstream, [dimension]: [...facetIds] })
  }

  /**
   * The tracks a facet row — or a selection of them — stands for.
   *
   * A right-click on an artist means "everything by them", and *everything* has
   * to be a query: the pane holds artist rows, not the tracks under them, and
   * asking main is the only way to learn what those are. This is where the
   * sidebar's verbs cross from facet identity to track identity.
   *
   * Which predicate applies is `facetFilters`' to say, above.
   *
   * ## Ordering and paging
   *
   * Ordered by the song list's current sort, so the tracks land in a playlist in
   * the order the operator would have seen had they clicked the row instead of
   * right-clicking it.
   *
   * Paged, because `MAX_TRACK_ID_PAGE` is 10,000 and an artist selection in a
   * library of the size D1 targets can exceed that. Sequential and concatenated
   * in request order for the reason `queueCommands.resolve` is: the order is the
   * point, and racing the pages would settle it by whichever returned first.
   */
  async function facetTrackIds(
    dimension: FacetDimension,
    facetIds: readonly number[]
  ): Promise<number[]> {
    if (facetIds.length === 0) return []
    const filters = facetFilters(dimension, facetIds)

    return collectPagedIds(MAX_TRACK_ID_PAGE, (offset, limit) =>
      library.listTrackIds({
        ...filters,
        sort: trackList.sort,
        direction: trackList.direction,
        offset,
        limit
      })
    )
  }

  return {
    rootId,
    rootValue,
    searchInput,
    searchPending,
    searchHelp,
    activeSearch,
    artists,
    albums,
    currentFilters,
    facetFilters,
    facetTrackIds,
    reloadFacets,
    revealArtist,
    revealSearch
  }
})
