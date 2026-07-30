<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { FermataError, library } from '@renderer/ipc'
import { measureLibraryQuery } from '@renderer/metrics'
import FacetList from '@renderer/panels/FacetList.vue'
import { createFacetWindow } from '@renderer/panels/facetWindow'
import {
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  type AlbumFacet,
  type ArtistFacet,
  type LibraryBrowseFilters,
  type LibraryRoot,
  type ScanProgress
} from '@shared/library'

const emit = defineEmits<{
  filtersChange: [filters: LibraryBrowseFilters]
  libraryChange: []
}>()

const ARTIST_ROW_HEIGHT = 32
const ALBUM_ROW_HEIGHT = 44
const SEARCH_DELAY_MS = 250

const roots = ref<LibraryRoot[]>([])
const rootId = ref<number | null>(null)
const searchInput = ref('')
const activeSearch = ref<string | null>(null)
const searchPending = ref(false)
const adding = ref(false)
const scan = ref<ScanProgress | null>(null)
const notice = ref<string | null>(null)

const artists = createFacetWindow<ArtistFacet>({
  dimension: 'artistIds',
  fetchPage: async (query) => {
    const result = await measureLibraryQuery('artists-query', () => library.listArtists(query))
    return { items: result.artists, total: result.total }
  },
  fetchIdPage: (query) => library.listArtistIds(query)
})
const albums = createFacetWindow<AlbumFacet>({
  dimension: 'albumIds',
  fetchPage: async (query) => {
    const result = await measureLibraryQuery('albums-query', () => library.listAlbums(query))
    return { items: result.albums, total: result.total }
  },
  fetchIdPage: (query) => library.listAlbumIds(query)
})

/**
 * The three predicates, narrowing left to right.
 *
 * Each pane is filtered by everything above it and never by itself: the artist
 * pane has to keep listing every artist under the root while some of them are
 * selected, or selecting a second one would be impossible.
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

const rootItems = computed(() => [
  { label: 'All folders', value: 0 },
  ...roots.value.map((root) => ({
    label: `${root.path} (${root.trackCount.toLocaleString()})`,
    value: root.id
  }))
])
/**
 * `0` is the sentinel for "All folders" in the select, and `null` is the absence
 * of a `rootId` in the filter. Changing it needs no validation of its own: the
 * two panes below are watching, and both prune whatever the narrower root no
 * longer contains.
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
 * The pruning is what makes a selection safe to keep across a narrowing rather
 * than something to clear defensively. Picking a second artist leaves the albums
 * of the first that they did not both record out of the pane entirely, and an
 * album still filtering the song list from outside the list it was chosen in is
 * a selection the user can neither see nor untick.
 *
 * Only downward. An artist selection is never pruned by an album selection,
 * because the album pane is downstream of it — that direction would let a click
 * in the lower pane silently rewrite the upper one.
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
watch(
  currentFilters,
  (filters) => {
    emit('filtersChange', { ...filters })
    performance.mark('fermata:library:browse-change')
  },
  { immediate: true }
)

let searchTimer: ReturnType<typeof setTimeout> | null = null
let stopScan: (() => void) | null = null
let stopNotice: (() => void) | null = null

function searchableText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.split(/\s+/u).some((term) => [...term].length >= MIN_SEARCH_LENGTH)
    ? trimmed
    : null
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

async function refreshRoots(): Promise<void> {
  try {
    roots.value = await library.listRoots()
  } catch {
    notice.value = 'Could not read library folders.'
  }
}

async function addFolder(): Promise<void> {
  adding.value = true
  notice.value = null
  try {
    const root = await library.addRoot()
    if (root) await refreshRoots()
  } catch (cause) {
    notice.value = cause instanceof FermataError ? cause.message : 'That folder could not be added.'
  } finally {
    adding.value = false
  }
}

defineExpose({ addFolder })

function reloadFacets(): void {
  artists.reload()
  albums.reload()
}

onMounted(async () => {
  stopScan = library.onScanProgress((progress) => {
    scan.value = progress.done ? null : progress
    if (progress.done) {
      void refreshRoots()
      reloadFacets()
      emit('libraryChange')
    }
  })
  stopNotice = library.onNotice((finding) => {
    notice.value = finding.message
    void refreshRoots()
  })
  await refreshRoots()
})

onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
  stopScan?.()
  stopNotice?.()
})
</script>

<template>
  <UCard
    as="aside"
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex h-full min-h-0 flex-col p-0 sm:p-0' }"
    aria-label="Library sources"
  >
    <div class="space-y-2 border-b border-default bg-elevated/40 p-2">
      <div class="flex items-center gap-2">
        <UIcon name="i-tabler-library" class="size-5 text-primary" />
        <h1 class="font-semibold text-highlighted">Library</h1>
        <UButton
          class="ml-auto"
          icon="i-tabler-folder-plus"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="adding"
          aria-label="Add library folder"
          @click="addFolder"
        />
      </div>

      <UFormField label="Library folder" :ui="{ label: 'sr-only' }">
        <USelect
          v-model="rootValue"
          value-key="value"
          :items="rootItems"
          class="w-full"
          aria-label="Library folder"
        />
      </UFormField>

      <UFormField label="Search library" :help="searchHelp" :ui="{ label: 'sr-only' }">
        <UInput
          v-model="searchInput"
          type="search"
          icon="i-tabler-search"
          class="w-full"
          placeholder="Search title, artist, album"
          :maxlength="MAX_SEARCH_LENGTH"
          :loading="searchPending || artists.loading.value || albums.loading.value"
          aria-label="Search library"
        />
      </UFormField>
    </div>

    <UAlert
      v-if="notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="notice"
      class="rounded-none"
    />

    <div v-if="scan" class="space-y-2 border-b border-default px-3 py-2" role="status">
      <UProgress animation="carousel" size="2xs" />
      <p class="text-xs text-muted">
        {{ scan.filesSeen }} found · {{ scan.tracksIndexed }} indexed
      </p>
      <p class="truncate text-xs text-muted">{{ scan.currentFile ?? 'Reading folders…' }}</p>
    </div>

    <section class="flex min-h-0 flex-1 basis-0 flex-col border-b border-default">
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Artists</h2>
        <template v-if="artists.selectionCount.value > 0">
          <span class="ml-auto text-xs tabular-nums text-primary" aria-live="polite">
            {{ artists.selectionCount.value.toLocaleString() }} selected
          </span>
          <UButton
            icon="i-tabler-x"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Clear artist selection"
            @click="artists.clearSelection()"
          />
        </template>
        <span
          class="text-xs tabular-nums text-dimmed"
          :class="{ 'ml-auto': artists.selectionCount.value === 0 }"
        >
          {{ artists.total.value.toLocaleString() }}
        </span>
      </div>

      <UAlert
        v-if="artists.error.value"
        color="warning"
        variant="subtle"
        icon="i-tabler-alert-triangle"
        :description="artists.error.value"
        class="rounded-none"
      />

      <FacetList :model="artists" :row-height="ARTIST_ROW_HEIGHT" label="Artists">
        <template #row="{ item }">
          <span class="truncate">{{ item?.name ?? 'Loading…' }}</span>
          <span class="ml-auto shrink-0 text-xs tabular-nums text-dimmed">
            {{ item?.trackCount ?? '' }}
          </span>
        </template>
      </FacetList>

      <UEmpty
        v-if="artists.total.value === 0 && !artists.loading.value"
        variant="naked"
        size="sm"
        icon="i-tabler-users"
        title="No artists match"
        class="min-h-0 flex-1"
      />
    </section>

    <section class="flex min-h-0 flex-1 basis-0 flex-col">
      <div class="flex h-8 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Albums</h2>
        <template v-if="albums.selectionCount.value > 0">
          <span class="ml-auto text-xs tabular-nums text-primary" aria-live="polite">
            {{ albums.selectionCount.value.toLocaleString() }} selected
          </span>
          <UButton
            icon="i-tabler-x"
            size="xs"
            color="neutral"
            variant="ghost"
            aria-label="Clear album selection"
            @click="albums.clearSelection()"
          />
        </template>
        <span
          class="text-xs tabular-nums text-dimmed"
          :class="{ 'ml-auto': albums.selectionCount.value === 0 }"
        >
          {{ albums.total.value.toLocaleString() }}
        </span>
      </div>

      <UAlert
        v-if="albums.error.value"
        color="warning"
        variant="subtle"
        icon="i-tabler-alert-triangle"
        :description="albums.error.value"
        class="rounded-none"
      />

      <FacetList :model="albums" :row-height="ALBUM_ROW_HEIGHT" label="Albums">
        <template #row="{ item }">
          <UAvatar
            :src="item?.artwork.small"
            :icon="item ? undefined : 'i-tabler-vinyl'"
            alt=""
            size="md"
            class="shrink-0 rounded"
            :ui="{ image: 'rounded object-cover', icon: 'size-4 text-dimmed' }"
            loading="lazy"
          />
          <span class="flex min-w-0 flex-col">
            <span class="truncate">{{ item?.title ?? 'Loading…' }}</span>
            <span class="truncate text-xs text-muted">
              {{ item ? (item.albumArtist ?? 'Unknown artist') : '' }}
            </span>
          </span>
          <span class="ml-auto shrink-0 text-xs tabular-nums text-dimmed">
            {{ item?.trackCount ?? '' }}
          </span>
        </template>
      </FacetList>

      <UEmpty
        v-if="albums.total.value === 0 && !albums.loading.value"
        variant="naked"
        size="sm"
        icon="i-tabler-vinyl"
        title="No albums match"
        class="min-h-0 flex-1"
      />
    </section>
  </UCard>
</template>
