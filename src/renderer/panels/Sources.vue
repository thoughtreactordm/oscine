<script setup lang="ts">
import { computed } from 'vue'
import type { ContextMenuItem, DropdownMenuItem } from '@nuxt/ui'
import type { AddTarget } from '@renderer/panels/addToPlaylist'
import { createFacetActivation } from '@renderer/panels/facetActivation'
import type { FacetDimension, FacetWindow } from '@renderer/panels/facetWindow'
import FacetList from '@renderer/panels/FacetList.vue'
import GenreFacetList from '@renderer/panels/GenreFacetList.vue'
import { panelSettingsSurface } from '@renderer/panels/settings/panelSettings'
import PanelSettingsPopover from '@renderer/panels/settings/PanelSettingsPopover.vue'
import { queueCommandLabel, queueIds } from '@renderer/playback/queueCommands'
import { useSettings } from '@renderer/settings'
import PaneResizer from '@renderer/shell/PaneResizer.vue'
import { SOURCES_ARTISTS_PANE, SOURCES_GENRES_PANE } from '@renderer/shell/shellLayout'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { useArtistFavorites } from '@renderer/stores/artistStars'
import { useBrowseStore } from '@renderer/stores/browse'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { useShellStore } from '@renderer/stores/shell'
import { useTrackListStore } from '@renderer/stores/trackList'
import { MAX_SEARCH_LENGTH, type AlbumFacet, type ArtistFacet } from '@shared/library'

const ARTIST_ROW_HEIGHT = 32
const ALBUM_ROW_HEIGHT = 44
const GENRE_ROW_HEIGHT = 28

const watchSettings = panelSettingsSurface('library-roots')

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
const playback = usePlaybackStore()
const playlists = usePlaylistsStore()
const trackList = useTrackListStore()
const artistFavorites = useArtistFavorites()

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

/**
 * The Genres & tags height, dragged and remembered — the same one-number split
 * as the Artists pane, one level up (W15-6). This pane carries a size and the
 * Artists/Albums split below takes what is left, so its handle moves a single
 * stored number and the inner split's own resizer math is untouched.
 */
const genresHeight = shell.paneSize(SOURCES_GENRES_PANE)

const rootItems = computed(() => [
  { label: 'All folders', value: 0 },
  ...roots.roots.map((root) => ({
    label: `${root.path} (${root.trackCount.toLocaleString()})`,
    value: root.id
  }))
])

/**
 * What the kebab beside the folder select offers, for whatever it is pointing at.
 *
 * `browse.rootValue` is `0` for "All folders", which is a real selection rather
 * than an absence — so the menu answers it rather than going empty: rescan
 * everything, and no removal, because "remove all folders" is not a gesture
 * anyone makes by accident and should not be one keystroke from a menu.
 *
 * Removal goes through `requestRemove` and never through `removeFolder`. The
 * confirmation is rendered by the title bar, which is the only component still
 * mounted when this one is not.
 */
const folderItems = computed<DropdownMenuItem[][]>(() => {
  const rootId = browse.rootValue
  const scanning = roots.scan !== null

  // Adding a folder is a create action rather than a verb on whatever the
  // select is pointing at, so it leads the menu in its own group and is offered
  // whether "All folders" or a single root is selected.
  const addGroup: DropdownMenuItem[] = [
    {
      label: 'Add folder…',
      icon: 'i-tabler-folder-plus',
      disabled: roots.adding,
      onSelect: () => void roots.addFolder()
    }
  ]

  if (rootId === 0) {
    return [
      addGroup,
      [
        {
          label: roots.roots.length > 1 ? 'Rescan all folders' : 'Rescan',
          icon: 'i-tabler-refresh',
          disabled: scanning || roots.roots.length === 0,
          onSelect: () => void roots.rescanAll()
        }
      ]
    ]
  }

  return [
    addGroup,
    [
      {
        label: 'Rescan this folder',
        icon: 'i-tabler-refresh',
        disabled: scanning,
        onSelect: () => void roots.rescan(rootId)
      }
    ],
    [
      {
        label: 'Remove this folder…',
        icon: 'i-tabler-folder-minus',
        color: 'error' as const,
        disabled: roots.removing !== null,
        onSelect: () => roots.requestRemove(rootId)
      }
    ]
  ]
})

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
interface FacetPaneSpec<T extends { id: number }> {
  model: FacetWindow<T>
  dimension: FacetDimension
  /** Plural, for the wording. `count` of one never uses it. */
  unit: string
  /** What to suggest as a new playlist's name for a single row. */
  nameOf: (item: T) => string
  /**
   * The star, for the panes whose rows can be favorited — artists today (**D24**,
   * product rule 6). Present makes the row menu carry a toggle whose wording
   * follows the current state; absent leaves the menu as it was. Keyed on the
   * facet `id`, which for artists is the `artists` row id the star store uses.
   */
  favorite?: {
    isFavorite: (id: number) => boolean
    toggle: (id: number) => void
    hydrate: (ids: readonly number[]) => void
    /** The noun in the menu label, e.g. "artist". */
    noun: string
  }
}

/**
 * What double-clicking a facet row does, which `interface.facetActivation`
 * decides.
 *
 * One instance for both panes, because it is one setting: an operator who wants
 * a double-clicked artist queued rather than played wants the same of an album.
 * What differs between the panes is the *target*, and that is built per row in
 * `facetPane` below.
 *
 * The row menu's own verbs still go straight to the queue. A verb the operator
 * named is not the gesture the setting is about — the same split `LibraryView`
 * and `PlaylistContents` already make for songs.
 */
const activation = createFacetActivation({
  settings: useSettings(),
  playNext: (trackIds) => queue.playNext(queueIds(trackIds)),
  addToQueue: (trackIds) => queue.addToQueue(queueIds(trackIds)),
  viewedPlaylistId: () => playlists.viewedPlaylistId,
  // Through `addTo`, so a double-click reports what it did the same way the
  // menu does: same wording, same failure text, same toast. The ids are already
  // resolved by the time this is called, so `count` can be the honest track
  // count rather than the menu's "3 artists".
  addToViewedPlaylist: (playlistId, trackIds) =>
    addToPlaylist.addTo(playlistId, {
      trackIds: () => Promise.resolve(trackIds),
      count: trackIds.length
    })
})

function facetPane<T extends { id: number }>(spec: FacetPaneSpec<T>) {
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

  function menu(index: number): ContextMenuItem[] {
    const item = spec.model.rowAt(index)
    const target = targetFor(index)
    // A row whose page has not arrived has no id to act on. Saying so beats an
    // empty menu, and beats verbs that would quietly do nothing.
    if (target === null || !item) return [{ label: 'Loading…', disabled: true }]

    const items: ContextMenuItem[] = [
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

    // The star acts on the one row under the pointer, not the selection: a
    // favorite is a boolean about an entity, and its state-aware label would be
    // a lie over a mixed set. `favorited` is reactive and hydrated on menu open,
    // so the wording is right by the time the menu paints (see `onMenuOpen`).
    if (spec.favorite) {
      const favorited = spec.favorite.isFavorite(item.id)
      items.push(
        { type: 'separator' },
        {
          label: favorited ? `Unfavorite ${spec.favorite.noun}` : `Favorite ${spec.favorite.noun}`,
          icon: favorited ? 'i-tabler-star-filled' : 'i-tabler-star',
          onSelect: () => spec.favorite?.toggle(item.id)
        }
      )
    }

    return items
  }

  /**
   * Hydrates the row's star the instant its menu opens, so the toggle's wording
   * reflects the real state on the first frame rather than defaulting to "not
   * favorited" until a batch lands. A no-op for panes without a star.
   */
  function onMenuOpen(index: number): void {
    if (!spec.favorite) return
    const item = spec.model.rowAt(index)
    if (item) spec.favorite.hydrate([item.id])
  }

  /**
   * A double-click, aimed at the one row under the pointer.
   *
   * Never the selection, which is what separates this from the menu above: the
   * `mousedown` that opened the double-click has already collapsed the
   * selection to this row, so "act on the selection" and "act on this row" have
   * the same answer — and reading the selection anyway would make the gesture
   * depend on a race between two handlers for the same click.
   *
   * Playing goes through `playFromList` and not through `trackIds`, so the
   * traversal is the library order narrowed to the row: paged and resolved a
   * position at a time, exactly as clicking a song is. No index, because the
   * gesture names a set and not a row — see `startOrder`, which is what makes
   * shuffle choose the opener rather than start at the top.
   */
  function activate(item: T): void {
    void activation.activate({
      play: () =>
        void playback.playFromList({
          sort: trackList.sort,
          direction: trackList.direction,
          filters: browse.facetFilters(spec.dimension, [item.id])
        }),
      trackIds: () => browse.facetTrackIds(spec.dimension, [item.id])
    })
  }

  return { menu, activate, onMenuOpen }
}

const artistPane = facetPane<ArtistFacet>({
  model: browse.artists,
  dimension: 'artistIds',
  unit: 'artists',
  nameOf: (artist) => artist.name,
  favorite: {
    isFavorite: (id) => artistFavorites.isFavorite(id),
    toggle: (id) => void artistFavorites.toggle(id),
    hydrate: (ids) => void artistFavorites.hydrate(ids),
    noun: 'artist'
  }
})

const albumPane = facetPane<AlbumFacet>({
  model: browse.albums,
  dimension: 'albumIds',
  unit: 'albums',
  nameOf: (album) => album.title
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Library sources">
    <div class="space-y-2 border-b border-default bg-elevated/40 p-2">
      <UFormField label="Library folder" :ui="{ label: 'sr-only' }">
        <div class="flex items-center gap-1">
          <USelect
            v-model="browse.rootValue"
            value-key="value"
            :items="rootItems"
            class="min-w-0 flex-1"
            aria-label="Library folder"
          />
          <!--
            The watcher settings and the folder verbs, grouped: both act on the
            roots the select is pointing at, and neither owns a folder of its
            own to sit beside. Watcher behaviour belongs here — the operator
            deciding whether a network share should be followed is looking at
            the share — and it is generated from the same registry the settings
            view renders, so this is those rows in a smaller frame rather than a
            second copy. The kebab carries the verbs for whatever the select
            names, adding a folder among them, so a folder is chosen once here
            rather than a second time from a title-bar list.
          -->
          <UFieldGroup>
            <PanelSettingsPopover :surface="watchSettings" size="md" />

            <UDropdownMenu :items="folderItems" :content="{ align: 'end' }">
              <UButton
                icon="i-tabler-dots-vertical"
                color="neutral"
                variant="ghost"
                :loading="roots.removing !== null"
                aria-label="Library folder actions"
              />
            </UDropdownMenu>
          </UFieldGroup>
        </div>
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

    <!--
      The Sources stack: Genres & tags on top, then the Artists/Albums split,
      each a draggable pane (W15-6). Genres carries a height and the split below
      takes what is left, so its handle moves one stored number — and the split's
      own two-pane resizer math is left exactly as it was, one level down,
      measuring its own parent and unaware of the pane above it.
    -->
    <div class="flex min-h-0 flex-1 flex-col">
      <!--
        Genres & tags — the browse dimension above artists and albums (W15-5),
        named the way the deck Tags pane and the TrackList column do.
      -->
      <section
        class="flex min-h-0 flex-col overflow-hidden"
        :style="{ height: `${genresHeight}px` }"
      >
        <div
          class="flex h-8 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-2"
        >
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
            Genres &amp; tags
          </h2>
          <template v-if="browse.genres.selectionCount.value > 0">
            <span class="ml-auto text-xs tabular-nums text-primary" aria-live="polite">
              {{ browse.genres.selectionCount.value.toLocaleString() }} selected
            </span>
            <UButton
              icon="i-tabler-x"
              size="xs"
              color="neutral"
              variant="ghost"
              aria-label="Clear genre and tag selection"
              @click="browse.genres.clearSelection()"
            />
          </template>
          <span
            class="text-xs tabular-nums text-dimmed"
            :class="{ 'ml-auto': browse.genres.selectionCount.value === 0 }"
          >
            {{ browse.genres.total.value.toLocaleString() }}
          </span>
        </div>

        <UAlert
          v-if="browse.genres.error.value"
          color="warning"
          variant="subtle"
          icon="i-tabler-alert-triangle"
          :description="browse.genres.error.value"
          class="rounded-none"
        />

        <div class="flex min-h-0 flex-1 flex-col">
          <GenreFacetList
            v-show="browse.genres.total.value > 0"
            :model="browse.genres"
            :row-height="GENRE_ROW_HEIGHT"
            label="Genres and tags"
          />
          <UEmpty
            v-if="browse.genres.total.value === 0 && !browse.genres.loading.value"
            variant="naked"
            size="sm"
            icon="i-tabler-tag"
            title="No genres or tags"
            class="min-h-0 flex-1"
          />
        </div>
      </section>

      <PaneResizer v-model:size="genresHeight" :pane="SOURCES_GENRES_PANE" />

      <!--
        The rest of the stack: the library-wide alerts and scan bar, then the
        Artists/Albums split. They sit inside this remainder — not between the
        two panes of the split below — so the split's handle still measures a
        parent whose height only a window resize can change.
      -->
      <div class="flex min-h-0 flex-1 flex-col">
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
          <p class="truncate text-xs text-muted">
            {{ roots.scan.currentFile ?? 'Reading folders…' }}
          </p>
        </div>

        <!--
          The Artists/Albums split. Its handle measures its own parent to know
          how much room there is to divide, so the alerts and scan bar stay
          outside it — one level up in the remainder — rather than between its
          two panes: an alert or a scan bar appearing inside here would change
          how tall the resizer believes the column is, mid-drag.
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
              :menu="artistPane.menu"
              @activate="artistPane.activate"
              @menu-open="artistPane.onMenuOpen"
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
              :menu="albumPane.menu"
              @activate="albumPane.activate"
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
      </div>
    </div>
  </section>
</template>
