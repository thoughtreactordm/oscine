<script setup lang="ts">
import { computed } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import type { AddTarget } from '@renderer/panels/addToPlaylist'
import type { FacetDimension, FacetWindow } from '@renderer/panels/facetWindow'
import FacetList from '@renderer/panels/FacetList.vue'
import { queueCommandLabel, queueIds } from '@renderer/playback/queueCommands'
import PaneResizer from '@renderer/shell/PaneResizer.vue'
import { SOURCES_ARTISTS_PANE } from '@renderer/shell/shellLayout'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { useBrowseStore } from '@renderer/stores/browse'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { useShellStore } from '@renderer/stores/shell'
import { MAX_SEARCH_LENGTH, type AlbumFacet, type ArtistFacet } from '@shared/library'

const ARTIST_ROW_HEIGHT = 32
const ALBUM_ROW_HEIGHT = 44

/**
 * The Library tab's sidebar contents, mounted by the frame above its cover pane.
 *
 * It used to be the sidebar itself, and to hand its predicate up to a parent
 * that owned the song list. It has no parent now — the sidebar and the body are
 * sibling routed views — so the predicate goes to a store the song list reads.
 *
 * It also used to *hold* that predicate, which is the part the routed shell got
 * wrong: a routed view is unmounted on every tab change, so the root, the search
 * text and both facet selections were being discarded by a look at Now Playing —
 * and the `immediate` watcher that rebuilt them wrote the empty predicate over
 * `trackList.filters` on the way back, resetting the song list too. All of it
 * lives in `browse` now and this is a view of it, the way `LibraryView` is
 * already a view of `trackList`. What is left here is layout, wording and the
 * two lists: nothing that answers "what is the library filtered to", which is
 * why nothing here is worth keeping across a mount.
 *
 * The folder list and the scan still belong to the frame, because the title bar
 * can start a scan from any tab.
 */
const roots = useLibraryRootsStore()
const browse = useBrowseStore()
const shell = useShellStore()
const queue = useQueueCommandsStore()
const addToPlaylist = useAddToPlaylistStore()

/**
 * The Artists/Albums divide, dragged and remembered.
 *
 * The same `PaneResizer` the frame uses down the side of its sidebar, turned on
 * its side — which is why that component takes an axis instead of being a
 * sidebar splitter. Only the upper pane carries a size and the lower one takes
 * what is left, so there is one number to store and no way for the two to add
 * up to something other than the column.
 */
const artistsHeight = shell.paneSize(SOURCES_ARTISTS_PANE)

const rootItems = computed(() => [
  { label: 'All folders', value: 0 },
  ...roots.roots.map((root) => ({
    label: `${root.path} (${root.trackCount.toLocaleString()})`,
    value: root.id
  }))
])

/**
 * The facet row menus: the same verbs the song list offers, aimed a level up.
 *
 * Right-clicking an artist is the gesture the operator has been reaching for
 * since there was a sidebar — "queue all of this", "put this album in Mix" —
 * and it needed nothing new to mean it. `browse.facetTrackIds` turns the row
 * into the tracks it stands for; from there the verbs are the ones the library
 * list already has, imported rather than restated so the two menus cannot drift.
 *
 * One builder for both panes, because the difference between them is a
 * dimension, a noun and where the name comes from. Two copies would be two
 * places to forget that a right-click keeps an existing selection.
 */
interface FacetMenuSpec<T extends { id: number }> {
  model: FacetWindow<T>
  dimension: FacetDimension
  /** Plural, for the wording. `count` of one never uses it. */
  unit: string
  /** What to suggest as a new playlist's name for a single row. */
  nameOf: (item: T) => string
}

function facetMenu<T extends { id: number }>(spec: FacetMenuSpec<T>) {
  /**
   * What the right-click is about: the selection when the row is in it, that row
   * alone when it is not — the rule `FacetList` has just applied to the
   * selection itself, read back here.
   *
   * `resolveSelection` rather than `selectedIds` for the reason the track list
   * uses it: a set has no order, and the order the operator sees is the order
   * these tracks should land in.
   */
  function targetFor(index: number): AddTarget | null {
    const item = spec.model.rowAt(index)
    if (!item) return null
    const selected = spec.model.isSelectedAt(index)
    const count = selected ? Math.max(1, spec.model.selectionCount.value) : 1
    const facetIds = selected
      ? (): Promise<readonly number[]> => spec.model.resolveSelection()
      : (): Promise<readonly number[]> => Promise.resolve([item.id])

    return {
      count,
      unit: spec.unit,
      // Only a single row names itself. "Add 6 albums to a playlist called
      // Rubber Soul" would be a suggestion that is actively wrong.
      suggestedName: count === 1 ? spec.nameOf(item) : undefined,
      trackIds: async () => browse.facetTrackIds(spec.dimension, await facetIds())
    }
  }

  return (index: number): ContextMenuItem[] => {
    const target = targetFor(index)
    // A row whose page has not arrived has no id to act on. Saying so beats an
    // empty menu, and beats verbs that would quietly do nothing.
    if (target === null) return [{ label: 'Loading…', disabled: true }]

    return [
      {
        label: queueCommandLabel('playNext', target.count, spec.unit),
        icon: 'i-tabler-corner-right-down',
        onSelect: () => void target.trackIds().then((ids) => queue.playNext(queueIds(ids)))
      },
      {
        label: queueCommandLabel('addToQueue', target.count, spec.unit),
        icon: 'i-tabler-list-numbers',
        onSelect: () => void target.trackIds().then((ids) => queue.addToQueue(queueIds(ids)))
      },
      { type: 'separator' },
      addToPlaylist.menuItem(target)
    ]
  }
}

const artistMenu = facetMenu<ArtistFacet>({
  model: browse.artists,
  dimension: 'artistIds',
  unit: 'artists',
  nameOf: (artist) => artist.name
})

const albumMenu = facetMenu<AlbumFacet>({
  model: browse.albums,
  dimension: 'albumIds',
  unit: 'albums',
  nameOf: (album) => album.title
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Library sources">
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
          :loading="roots.adding"
          aria-label="Add library folder"
          @click="roots.addFolder()"
        />
      </div>

      <UFormField label="Library folder" :ui="{ label: 'sr-only' }">
        <USelect
          v-model="browse.rootValue"
          value-key="value"
          :items="rootItems"
          class="w-full"
          aria-label="Library folder"
        />
      </UFormField>

      <UFormField label="Search library" :help="browse.searchHelp" :ui="{ label: 'sr-only' }">
        <UInput
          v-model="browse.searchInput"
          type="search"
          icon="i-tabler-search"
          class="w-full"
          placeholder="Search title, artist, album"
          :maxlength="MAX_SEARCH_LENGTH"
          :loading="
            browse.searchPending || browse.artists.loading.value || browse.albums.loading.value
          "
          aria-label="Search library"
        />
      </UFormField>
    </div>

    <UAlert
      v-if="roots.notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="roots.notice"
      class="rounded-none"
    />

    <div v-if="roots.scan" class="space-y-2 border-b border-default px-3 py-2" role="status">
      <UProgress animation="carousel" size="2xs" />
      <p class="text-xs text-muted">
        {{ roots.scan.filesSeen }} found · {{ roots.scan.tracksIndexed }} indexed
      </p>
      <p class="truncate text-xs text-muted">{{ roots.scan.currentFile ?? 'Reading folders…' }}</p>
    </div>

    <!--
      The split, and nothing above it. The handle measures its own parent to
      know how much room there is to divide, so the header has to stay outside:
      an alert or a scan bar appearing would otherwise change how tall the
      resizer believes the column is, mid-drag.
    -->
    <div class="flex min-h-0 flex-1 flex-col">
      <section
        class="flex min-h-0 flex-col overflow-hidden"
        :style="{ height: `${artistsHeight}px` }"
      >
        <div
          class="flex h-8 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-2"
        >
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Artists</h2>
          <template v-if="browse.artists.selectionCount.value > 0">
            <span class="ml-auto text-xs tabular-nums text-primary" aria-live="polite">
              {{ browse.artists.selectionCount.value.toLocaleString() }} selected
            </span>
            <UButton
              icon="i-tabler-x"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Clear artist selection"
              @click="browse.artists.clearSelection()"
            />
          </template>
          <span
            class="text-xs tabular-nums text-dimmed"
            :class="{ 'ml-auto': browse.artists.selectionCount.value === 0 }"
          >
            {{ browse.artists.total.value.toLocaleString() }}
          </span>
        </div>

        <UAlert
          v-if="browse.artists.error.value"
          color="warning"
          variant="subtle"
          icon="i-tabler-alert-triangle"
          :description="browse.artists.error.value"
          class="rounded-none"
        />

        <FacetList
          :model="browse.artists"
          :row-height="ARTIST_ROW_HEIGHT"
          label="Artists"
          :menu="artistMenu"
        >
          <template #row="{ item }">
            <span class="truncate">{{ item?.name ?? 'Loading…' }}</span>
            <span class="ml-auto shrink-0 text-xs tabular-nums text-dimmed">
              {{ item?.trackCount ?? '' }}
            </span>
          </template>
        </FacetList>

        <UEmpty
          v-if="browse.artists.total.value === 0 && !browse.artists.loading.value"
          variant="naked"
          size="sm"
          icon="i-tabler-users"
          title="No artists match"
          class="min-h-0 flex-1"
        />
      </section>

      <PaneResizer v-model:size="artistsHeight" :pane="SOURCES_ARTISTS_PANE" />

      <section class="flex min-h-44 flex-1 flex-col overflow-hidden">
        <div
          class="flex h-8 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-2"
        >
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Albums</h2>
          <template v-if="browse.albums.selectionCount.value > 0">
            <span class="ml-auto text-xs tabular-nums text-primary" aria-live="polite">
              {{ browse.albums.selectionCount.value.toLocaleString() }} selected
            </span>
            <UButton
              icon="i-tabler-x"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Clear album selection"
              @click="browse.albums.clearSelection()"
            />
          </template>
          <span
            class="text-xs tabular-nums text-dimmed"
            :class="{ 'ml-auto': browse.albums.selectionCount.value === 0 }"
          >
            {{ browse.albums.total.value.toLocaleString() }}
          </span>
        </div>

        <UAlert
          v-if="browse.albums.error.value"
          color="warning"
          variant="subtle"
          icon="i-tabler-alert-triangle"
          :description="browse.albums.error.value"
          class="rounded-none"
        />

        <FacetList
          :model="browse.albums"
          :row-height="ALBUM_ROW_HEIGHT"
          label="Albums"
          :menu="albumMenu"
        >
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
          v-if="browse.albums.total.value === 0 && !browse.albums.loading.value"
          variant="naked"
          size="sm"
          icon="i-tabler-vinyl"
          title="No albums match"
          class="min-h-0 flex-1"
        />
      </section>
    </div>
  </section>
</template>
