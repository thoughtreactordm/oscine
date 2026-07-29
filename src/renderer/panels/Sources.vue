<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ListboxItem } from '@nuxt/ui'
import { FermataError, library } from '@renderer/ipc'
import { measureLibraryQuery } from '@renderer/metrics'
import { createFacetWindow, type FacetWindow } from '@renderer/panels/facetWindow'
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

interface BrowserListItem<T extends ArtistFacet | AlbumFacet> extends ListboxItem {
  value: string
  facetIndex: number | null
  facet?: T
  count?: number
}

const roots = ref<LibraryRoot[]>([])
const rootId = ref<number | null>(null)
const artistId = ref<number | null>(null)
const albumId = ref<number | null>(null)
const searchInput = ref('')
const activeSearch = ref<string | null>(null)
const searchPending = ref(false)
const adding = ref(false)
const scan = ref<ScanProgress | null>(null)
const notice = ref<string | null>(null)

const artists = createFacetWindow<ArtistFacet>({
  fetchPage: async (query) => {
    const result = await measureLibraryQuery('artists-query', () => library.listArtists(query))
    return { items: result.artists, total: result.total }
  }
})
const albums = createFacetWindow<AlbumFacet>({
  fetchPage: async (query) => {
    const result = await measureLibraryQuery('albums-query', () => library.listAlbums(query))
    return { items: result.albums, total: result.total }
  }
})

const currentFilters = computed<LibraryBrowseFilters>(() => ({
  ...(rootId.value === null ? {} : { rootId: rootId.value }),
  ...(artistId.value === null ? {} : { artistId: artistId.value }),
  ...(albumId.value === null ? {} : { albumId: albumId.value }),
  ...(activeSearch.value === null ? {} : { searchText: activeSearch.value })
}))
const artistFilters = computed<LibraryBrowseFilters>(() => ({
  ...(rootId.value === null ? {} : { rootId: rootId.value }),
  ...(activeSearch.value === null ? {} : { searchText: activeSearch.value })
}))
const albumFilters = computed<LibraryBrowseFilters>(() => ({
  ...artistFilters.value,
  ...(artistId.value === null ? {} : { artistId: artistId.value })
}))

const rootItems = computed(() => [
  { label: 'All folders', value: 0 },
  ...roots.value.map((root) => ({
    label: `${root.path} (${root.trackCount.toLocaleString()})`,
    value: root.id
  }))
])
const rootValue = computed({
  get: () => rootId.value ?? 0,
  set: (value: number | undefined) => {
    void selectRoot(value ?? 0)
  }
})
const artistValue = computed(() =>
  artistId.value === null ? 'all-artists' : `artist:${artistId.value}`
)
const albumValue = computed(() =>
  albumId.value === null ? 'all-albums' : `album:${albumId.value}`
)

const artistItems = computed<Array<BrowserListItem<ArtistFacet>>>(() => [
  { label: 'All Artists', value: 'all-artists', facetIndex: null },
  ...Array.from({ length: artists.total.value }, (_, index) => {
    const facet = artists.rowAt(index)
    return {
      label: facet?.name ?? 'Loading…',
      value: facet ? `artist:${facet.id}` : `artist-loading:${index}`,
      facetIndex: index,
      facet,
      count: facet?.trackCount,
      disabled: facet === undefined
    }
  })
])
const albumItems = computed<Array<BrowserListItem<AlbumFacet>>>(() => [
  { label: 'All Albums', value: 'all-albums', facetIndex: null },
  ...Array.from({ length: albums.total.value }, (_, index) => {
    const facet = albums.rowAt(index)
    return {
      label: facet?.title ?? 'Loading…',
      description: facet?.albumArtist ?? (facet ? 'Unknown artist' : undefined),
      value: facet ? `album:${facet.id}` : `album-loading:${index}`,
      facetIndex: index,
      facet,
      count: facet?.trackCount,
      disabled: facet === undefined
    }
  })
])

watch(artistFilters, (filters) => artists.setFilters(filters), { immediate: true })
watch(albumFilters, (filters) => albums.setFilters(filters), { immediate: true })
watch(
  currentFilters,
  (filters) => {
    emit('filtersChange', { ...filters })
    performance.mark('fermata:library:browse-change')
  },
  { immediate: true }
)

let searchTimer: ReturnType<typeof setTimeout> | null = null
let validationGeneration = 0
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

function requestItem<T extends ArtistFacet | AlbumFacet>(
  item: BrowserListItem<T>,
  model: FacetWindow<T>
): void {
  if (item.facetIndex === null || item.facet) return
  const index = item.facetIndex
  queueMicrotask(() => model.ensureRange(Math.max(0, index - 8), index + 8))
}

function artistLabel(item: BrowserListItem<ArtistFacet>): string {
  requestItem(item, artists)
  return item.label ?? 'Loading…'
}

function albumLabel(item: BrowserListItem<AlbumFacet>): string {
  requestItem(item, albums)
  return item.label ?? 'Loading…'
}

async function refreshRoots(): Promise<void> {
  try {
    roots.value = await library.listRoots()
  } catch {
    notice.value = 'Could not read library folders.'
  }
}

async function selectionExists(filters: LibraryBrowseFilters): Promise<boolean> {
  const result = await library.listAlbums({ ...filters, offset: 0, limit: 1 })
  return result.total > 0
}

async function artistExists(filters: LibraryBrowseFilters): Promise<boolean> {
  const result = await library.listArtists({ ...filters, offset: 0, limit: 1 })
  return result.total > 0
}

async function selectArtist(item: ArtistFacet | null): Promise<void> {
  const requested = ++validationGeneration
  const nextArtistId = item?.id ?? null
  if (albumId.value !== null && nextArtistId !== null) {
    const valid = await selectionExists({
      ...artistFilters.value,
      artistId: nextArtistId,
      albumId: albumId.value
    })
    if (requested !== validationGeneration) return
    if (!valid) albumId.value = null
  }
  artistId.value = nextArtistId
}

function selectAlbum(item: AlbumFacet | null): void {
  validationGeneration++
  albumId.value = item?.id ?? null
}

function updateArtist(value: string | undefined): void {
  if (!value || value === 'all-artists') {
    void selectArtist(null)
    return
  }
  const item = artistItems.value.find((candidate) => candidate.value === value)
  if (item?.facet) void selectArtist(item.facet)
}

function updateAlbum(value: string | undefined): void {
  if (!value || value === 'all-albums') {
    selectAlbum(null)
    return
  }
  const item = albumItems.value.find((candidate) => candidate.value === value)
  if (item?.facet) selectAlbum(item.facet)
}

async function selectRoot(value: number): Promise<void> {
  const nextRoot = value > 0 ? value : null
  const requested = ++validationGeneration

  if (artistId.value !== null) {
    const valid = await artistExists({
      ...(nextRoot === null ? {} : { rootId: nextRoot }),
      artistId: artistId.value,
      ...(activeSearch.value === null ? {} : { searchText: activeSearch.value })
    })
    if (requested !== validationGeneration) return
    if (!valid) {
      artistId.value = null
      albumId.value = null
    }
  }
  if (albumId.value !== null) {
    const valid = await selectionExists({
      ...(nextRoot === null ? {} : { rootId: nextRoot }),
      ...(artistId.value === null ? {} : { artistId: artistId.value }),
      albumId: albumId.value
    })
    if (requested !== validationGeneration) return
    if (!valid) albumId.value = null
  }
  rootId.value = nextRoot
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
        <UIcon name="i-lucide-library" class="size-5 text-primary" />
        <h1 class="font-semibold text-highlighted">Library</h1>
        <UButton
          class="ml-auto"
          icon="i-lucide-folder-plus"
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
          icon="i-lucide-search"
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
      icon="i-lucide-triangle-alert"
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
      <div class="flex h-8 shrink-0 items-center border-b border-default bg-elevated/30 px-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Artists</h2>
        <span class="ml-auto text-xs tabular-nums text-dimmed">{{ artists.total.value }}</span>
      </div>

      <UAlert
        v-if="artists.error.value"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="artists.error.value"
        class="rounded-none"
      />

      <UListbox
        :model-value="artistValue"
        value-key="value"
        :items="artistItems"
        :loading="artists.loading.value && artists.total.value === 0"
        :virtualize="{ estimateSize: ARTIST_ROW_HEIGHT, overscan: 8 }"
        size="sm"
        class="min-h-0 flex-1 rounded-none ring-0"
        :ui="{
          root: 'h-full min-h-0 rounded-none ring-0',
          content:
            'h-full min-h-0 max-h-none overflow-y-auto overscroll-contain [scrollbar-gutter:stable]',
          item: 'h-8 items-center px-2 py-0',
          itemWrapper: 'justify-center',
          itemTrailingIcon: 'hidden'
        }"
        aria-label="Artists"
        @update:model-value="updateArtist"
      >
        <template #item-label="{ item }">
          {{ artistLabel(item) }}
        </template>
        <template #item-trailing="{ item }">
          <span class="tabular-nums text-xs text-dimmed">{{ item.count ?? '' }}</span>
        </template>
      </UListbox>

      <UEmpty
        v-if="artists.total.value === 0 && !artists.loading.value"
        variant="naked"
        size="sm"
        icon="i-lucide-users"
        title="No artists match"
        class="min-h-0 flex-1"
      />
    </section>

    <section class="flex min-h-0 flex-1 basis-0 flex-col">
      <div class="flex h-8 shrink-0 items-center border-b border-default bg-elevated/30 px-2">
        <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Albums</h2>
        <span class="ml-auto text-xs tabular-nums text-dimmed">{{ albums.total.value }}</span>
      </div>

      <UAlert
        v-if="albums.error.value"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="albums.error.value"
        class="rounded-none"
      />

      <UListbox
        :model-value="albumValue"
        value-key="value"
        :items="albumItems"
        :loading="albums.loading.value && albums.total.value === 0"
        :virtualize="{ estimateSize: ALBUM_ROW_HEIGHT, overscan: 8 }"
        size="sm"
        class="min-h-0 flex-1 rounded-none ring-0"
        :ui="{
          root: 'h-full min-h-0 rounded-none ring-0',
          content:
            'h-full min-h-0 max-h-none overflow-y-auto overscroll-contain [scrollbar-gutter:stable]',
          item: 'h-11 items-center px-2 py-0',
          itemWrapper: 'justify-center',
          itemTrailingIcon: 'hidden'
        }"
        aria-label="Albums"
        @update:model-value="updateAlbum"
      >
        <template #item-leading="{ item }">
          <UAvatar
            :src="item.facet?.artwork.small"
            :icon="item.facet ? undefined : 'i-lucide-disc-3'"
            alt=""
            size="md"
            class="rounded"
            :ui="{ image: 'rounded object-cover', icon: 'size-4 text-dimmed' }"
            loading="lazy"
          />
        </template>
        <template #item-label="{ item }">
          {{ albumLabel(item) }}
        </template>
        <template #item-trailing="{ item }">
          <span class="tabular-nums text-xs text-dimmed">{{ item.count ?? '' }}</span>
        </template>
      </UListbox>

      <UEmpty
        v-if="albums.total.value === 0 && !albums.loading.value"
        variant="naked"
        size="sm"
        icon="i-lucide-disc-3"
        title="No albums match"
        class="min-h-0 flex-1"
      />
    </section>
  </UCard>
</template>
