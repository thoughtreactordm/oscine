<script setup lang="ts">
import { computed, onMounted, shallowRef, watch } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import { discover, OscineError, library } from '@renderer/ipc'
import { createFacetActivation } from '@renderer/panels/facetActivation'
import { collectPagedIds } from '@renderer/panels/pagedIds'
import { useTrackActivation } from '@renderer/panels/useTrackActivation'
import {
  albumPlayParams,
  coverSrc,
  discoverItemKey,
  discoverViewState,
  showPlaceholderBadge,
  type DiscoverView
} from '@renderer/panels/discoverShelves'
import { trackMenuItems } from '@renderer/panels/trackMenu'
import { useTrackActions } from '@renderer/panels/useTrackActions'
import { queueCommandLabel, queueIds } from '@renderer/playback/queueCommands'
import { useSettings } from '@renderer/settings'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { useFavoritesStore } from '@renderer/stores/favorites'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { useTrackInfoStore } from '@renderer/stores/trackInfo'
import type {
  DiscoverAlbumItem,
  DiscoverItem,
  DiscoverRecipeId,
  DiscoverShelvesResult,
  DiscoverTrackItem
} from '@shared/discover'
import { MAX_TRACK_ID_PAGE } from '@shared/library'

/**
 * What Discover shows: today's named recipes, fetched from main.
 *
 * The renderer does not compute shelves. It asks `discover.shelves` and draws
 * what comes back — dynamic titles, static hints, at most ten cards per strip,
 * omitted recipes simply absent. That is why a cold-start library is one
 * `unplayed` row rather than three empty-headed skeletons, and why an empty
 * library is a designed empty rather than fake vinyls.
 *
 * The Placeholder badge is for "these cards are skeletons". A real result,
 * including one shelf and including a cold-start `unplayed`, takes it off.
 *
 * Not virtualized, and not an exception to the invariant: the query is capped
 * at ten, so the strip is never the 100k-track list the invariant is about. A
 * "see all unplayed" is a Library filter, not an unbounded Discover scroller.
 *
 * Play reuses Library's album activation and the song list's `trackActivation`.
 * Queue is TrackList's secondary gesture, per card. Save snapshots the last
 * `shelves` result as an ordinary playlist and lands Curate on it.
 *
 * A different idiom from the Library tab on purpose. Library is where a hundred
 * thousand tracks are searched, and it is a dense grid of rows because that is
 * what searching wants. Discover is where a few dozen curated things are
 * browsed, and a wall of artwork is what browsing wants.
 */

/** Untitled strips. Naming them would flash `for-you` over a cold start. */
const SKELETON_STRIPS = [6, 6] as const

const roots = useLibraryRootsStore()
const hearts = useFavoritesStore()
const playback = usePlaybackStore()
const queue = useQueueCommandsStore()
const playlists = usePlaylistsStore()
const addToPlaylist = useAddToPlaylistStore()
const trackInfo = useTrackInfoStore()
const trackActions = useTrackActions()

const result = shallowRef<DiscoverShelvesResult | null>(null)
const loading = shallowRef(false)
const failed = shallowRef(false)
const savingId = shallowRef<DiscoverRecipeId | null>(null)
let issued = 0

const view = computed<DiscoverView>(() => ({
  failed: failed.value,
  answered: result.value !== null,
  shelfCount: result.value?.shelves.length ?? 0
}))

const state = computed(() => discoverViewState(view.value))
const placeholder = computed(() => showPlaceholderBadge(state.value))

/**
 * Album cards take the facet setting — they are albums, and a double-click
 * that queues an album in the sidebar should queue one here too. Track cards
 * take the song-list setting. `playNow` for a track is that one track, not
 * the shelf: there is no "queue the whole shelf" in 1.0.
 */
const albumActivation = createFacetActivation({
  settings: useSettings(),
  playNext: (trackIds) => queue.playNext(queueIds(trackIds)),
  addToQueue: (trackIds) => queue.addToQueue(queueIds(trackIds)),
  viewedPlaylistId: () => playlists.viewedPlaylistId,
  addToViewedPlaylist: (playlistId, trackIds) =>
    addToPlaylist.addTo(playlistId, {
      trackIds: () => Promise.resolve(trackIds),
      count: trackIds.length
    })
})

const trackActivation = useTrackActivation((track) => {
  void playback.playTracks({ tracks: [track], index: 0 })
})

onMounted(() => {
  void load()
})

watch(
  () => roots.version,
  () => {
    void load()
  }
)

watch(
  () => hearts.changed,
  (change) => {
    if (change === null) return
    void load()
  }
)

async function load(): Promise<void> {
  const request = ++issued
  loading.value = true
  failed.value = false
  try {
    const next = await discover.shelves()
    if (request !== issued) return
    result.value = next
  } catch {
    if (request !== issued) return
    result.value = null
    failed.value = true
  } finally {
    if (request === issued) loading.value = false
  }
}

/**
 * Every track on the album, disc/track/id — the same query Library uses when
 * a facet row is queued. Discover does not inherit the Library tab's browse
 * predicate; the album id is the whole filter.
 */
function albumTrackIds(albumId: number): Promise<number[]> {
  return collectPagedIds(MAX_TRACK_ID_PAGE, (offset, limit) =>
    library.listTrackIds({
      albumIds: [albumId],
      sort: 'trackNo',
      direction: 'asc',
      offset,
      limit
    })
  )
}

function activateAlbum(item: DiscoverAlbumItem): void {
  const params = albumPlayParams(item.albumId)
  void albumActivation.activate({
    play: () => void playback.playFromList(params),
    trackIds: () => albumTrackIds(item.albumId)
  })
}

async function activateItem(item: DiscoverItem): Promise<void> {
  if (item.grain === 'album') {
    activateAlbum(item)
    return
  }
  const [track] = await library.getTracksByIds({ ids: [item.trackId] })
  if (!track) return
  await trackActivation.activate(track, 0)
}

/**
 * Play one track card now, fetching the row the card only holds an id for.
 *
 * The card carries display text and a `trackId`, not a `Track`; Play and Track
 * Info both need the row, so each fetches it on select rather than the strip
 * widening every card up front for a menu that may never open.
 */
async function playTrackCard(item: DiscoverTrackItem): Promise<void> {
  const [track] = await library.getTracksByIds({ ids: [item.trackId] })
  if (track) playback.playTracks({ tracks: [track], index: 0 })
}

async function showTrackInfo(item: DiscoverTrackItem): Promise<void> {
  const [track] = await library.getTracksByIds({ ids: [item.trackId] })
  if (track) trackInfo.show(track)
}

/**
 * The card menus (**G8**).
 *
 * A track card gets the shared single-track set (`trackMenu`), the same one the
 * lists and Now Playing build. An album card gets the album-scoped verbs — the
 * queue and playlist ones aimed at the whole run, View album at the record and
 * View artist at whoever made it — but no Track Info, which is a fact about one
 * file and an album is many.
 */
function itemMenu(item: DiscoverItem): ContextMenuItem[] {
  if (item.grain === 'album') {
    const trackIds = (): Promise<number[]> => albumTrackIds(item.albumId)
    return [
      {
        label: 'Play',
        icon: 'i-tabler-player-play',
        onSelect: () => void playback.playFromList(albumPlayParams(item.albumId))
      },
      {
        label: queueCommandLabel('playNext', item.trackCount),
        icon: 'i-tabler-corner-right-down',
        onSelect: () => void trackIds().then((ids) => queue.playNext(queueIds(ids)))
      },
      {
        label: queueCommandLabel('addToQueue', item.trackCount),
        icon: 'i-tabler-list-numbers',
        onSelect: () => void trackIds().then((ids) => queue.addToQueue(queueIds(ids)))
      },
      { type: 'separator' },
      addToPlaylist.menuItem({ count: item.trackCount, trackIds, suggestedName: item.title }),
      { type: 'separator' },
      {
        label: 'View artist',
        icon: 'i-tabler-user',
        disabled: item.artist === null,
        onSelect: trackActions.viewArtist(item.artist) ?? undefined
      },
      {
        label: 'View album',
        icon: 'i-tabler-vinyl',
        onSelect: () => void trackActions.reveal(item.title)
      }
    ]
  }
  return trackMenuItems({
    play: () => void playTrackCard(item),
    playNext: () => void queue.playNext(queueIds([item.trackId])),
    addToQueue: () => void queue.addToQueue(queueIds([item.trackId])),
    addToPlaylist: addToPlaylist.menuItem({
      count: 1,
      trackIds: () => Promise.resolve([item.trackId])
    }),
    viewArtist: trackActions.viewArtist(item.artist),
    viewAlbum: trackActions.viewAlbum(item.albumTitle),
    trackInfo: () => void showTrackInfo(item)
  })
}

async function save(recipeId: DiscoverRecipeId): Promise<void> {
  if (savingId.value !== null) return
  savingId.value = recipeId
  try {
    const playlist = await discover.saveShelf(recipeId)
    await playlists.viewCreated(playlist)
  } catch (cause) {
    playlists.notice =
      cause instanceof OscineError ? cause.message : 'That shelf could not be saved.'
  } finally {
    savingId.value = null
  }
}
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto" :aria-busy="loading">
    <div class="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-8">
      <header class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <p class="text-xs font-semibold uppercase tracking-widest text-primary">Discover</p>
          <UBadge v-if="placeholder" color="neutral" variant="subtle" size="sm">Placeholder</UBadge>
        </div>
        <h2 class="text-3xl font-bold tracking-tight text-highlighted">
          Everything you own, arranged for you
        </h2>
        <p class="max-w-prose text-sm text-muted">
          Shelves that read your library the way a streaming service reads its catalogue — except
          the catalogue is yours, and nothing here phones anywhere. Save a shelf as a playlist when
          you want to keep today's pick; pick a playlist from the rail to edit one.
        </p>
      </header>

      <UAlert
        v-if="state === 'failed'"
        color="warning"
        variant="subtle"
        icon="i-tabler-alert-triangle"
        title="Could not read your shelves"
        description="The library did not answer. Nothing has been lost. The files are still on disk."
        :actions="[{ label: 'Retry', color: 'neutral', onClick: () => load() }]"
      />

      <UEmpty
        v-else-if="state === 'empty'"
        variant="naked"
        icon="i-tabler-vinyl"
        title="Nothing on the shelves yet"
        description="Add a music folder and the records in it show up here, arranged from what you own and nowhere else."
      />

      <div v-else-if="state === 'loading'" role="status" aria-label="Reading your shelves">
        <section v-for="(slots, index) in SKELETON_STRIPS" :key="index" class="flex flex-col gap-3">
          <div class="flex items-baseline gap-3">
            <USkeleton class="h-4 w-36" />
            <USkeleton class="h-3 w-48" />
          </div>
          <div class="flex gap-4 overflow-x-auto pb-1">
            <div v-for="slot in slots" :key="slot" class="flex w-40 shrink-0 flex-col gap-2">
              <div
                class="flex aspect-square items-center justify-center rounded-lg border border-default bg-elevated/60"
              >
                <UIcon name="i-tabler-vinyl" class="size-8 text-dimmed/40" aria-hidden="true" />
              </div>
              <USkeleton class="h-3 w-3/4" />
              <USkeleton class="h-3 w-1/2" />
            </div>
          </div>
        </section>
      </div>

      <div
        v-else
        class="flex flex-col gap-10 transition-opacity"
        :class="loading ? 'opacity-60' : 'opacity-100'"
      >
        <section
          v-for="shelf in result?.shelves"
          :key="shelf.id"
          class="flex flex-col gap-3"
          :aria-labelledby="`discover-shelf-${shelf.id}`"
        >
          <div class="flex items-baseline gap-3">
            <h3 :id="`discover-shelf-${shelf.id}`" class="text-sm font-semibold text-highlighted">
              {{ shelf.title }}
            </h3>
            <p class="min-w-0 flex-1 truncate text-xs text-dimmed">{{ shelf.hint }}</p>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-playlist-add"
              label="Save as playlist"
              :loading="savingId === shelf.id"
              :disabled="savingId !== null"
              @click="save(shelf.id)"
            />
          </div>

          <!--
            Its own horizontal scroller per shelf. Ten cards do not get a
            windowing library — the cap is the reason the invariant does not
            apply here. `overflow-x-auto` rather than a wrap so each strip
            keeps its own scroll axis.
          -->
          <div class="flex gap-4 overflow-x-auto pb-1">
            <UContextMenu
              v-for="item in shelf.items"
              :key="discoverItemKey(item)"
              :items="itemMenu(item)"
              :ui="{ content: 'w-56' }"
            >
              <article
                class="flex w-40 shrink-0 cursor-default flex-col gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
                tabindex="0"
                :aria-label="`Play ${item.title}`"
                @click="activateItem(item)"
                @keydown.enter.prevent="activateItem(item)"
              >
                <div
                  class="aspect-square overflow-hidden rounded-lg border border-default bg-elevated/60 transition-colors hover:border-primary/40"
                >
                  <img
                    v-if="item.artworkHash !== null"
                    :src="coverSrc(item.artworkHash)"
                    alt=""
                    aria-hidden="true"
                    class="size-full object-cover"
                    loading="lazy"
                    draggable="false"
                  />
                  <div v-else class="flex size-full items-center justify-center">
                    <UIcon name="i-tabler-vinyl" class="size-8 text-dimmed/40" aria-hidden="true" />
                  </div>
                </div>
                <div class="min-w-0">
                  <p
                    class="line-clamp-2 text-sm font-medium leading-snug text-highlighted"
                    :title="item.title"
                  >
                    {{ item.title }}
                  </p>
                  <p class="mt-0.5 truncate text-xs text-muted" :title="item.why">{{ item.why }}</p>
                </div>
              </article>
            </UContextMenu>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
