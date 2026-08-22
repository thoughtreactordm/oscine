<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import { visibleRange } from '@renderer/panels/listViewport'
import { createPlaylistRail, PLAYLIST_NAME_MAX_LENGTH } from '@renderer/panels/playlistRail'
import type { DropSide } from '@renderer/panels/playlistReorder'
import { DISCOVER_TAB, FAVORITES_TAB } from '@renderer/panels/playlistTabs'
import { useSettings } from '@renderer/settings'
import { useFavoritesListStore } from '@renderer/stores/favoritesList'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import type { Playlist } from '@shared/playlists'
import { CONFIRM_PLAYLIST_DELETE_KEY } from '@shared/settings'

/**
 * Curate's chooser: Discover, My Favorites, and every playlist.
 *
 * Clicking an entry views it in the pane next door. There is no tab strip to
 * open something into — the rail *is* the switcher — so a click is a view and a
 * double-click is a play. Virtualized, per the standing invariant: this holds
 * however many playlists exist, and a rail that rendered two hundred rows to
 * show twelve is the same mistake as a track list that renders 100k.
 * `listViewport` and nothing else — the playlists are already in memory, so
 * there is nothing to page and what is left is arithmetic.
 *
 * ## Discover and My Favorites, pinned above the list
 *
 * Both are drawn *outside* the scroll container and outside `createPlaylistRail`
 * entirely, and that placement is the design rather than a layout convenience.
 * The model holds `rows`, the focus index, the reorder drag and the delete
 * prompt, all of them keyed by `playlists.id`; the pinned entries have no id
 * and belong to none of them. So they cannot be dragged, cannot be a drop
 * target, cannot be focused into a reorder and cannot be handed to
 * `requestDelete` — not because a branch refuses, but because they are not in
 * the list those verbs traverse. That is the same trick `DISCOVER_TAB` used to
 * play in the strip, now played here for both fixtures.
 *
 * The rename and delete affordances are therefore *absent*, not disabled: these
 * rows have no context menu and no inline input, where every row below them has
 * both.
 *
 * D4 island rules: it imports no sibling panel and holds no reference to the
 * contents pane. They meet at the stores.
 */

const playlists = usePlaylistsStore()
const playback = usePlaybackStore()
const settings = useSettings()
const favorites = useFavoritesListStore()

/** Whether a pinned entry is the thing on screen. Neither is ever the *playing* one. */
const discoverViewed = computed(() => playlists.viewedStop === DISCOVER_TAB)
const favoritesViewed = computed(() => playlists.viewedStop === FAVORITES_TAB)

/**
 * Plays the whole collection, with no row named — the same call shape the rail's
 * double-click makes for a playlist, and for the same reason: omitting the index
 * makes it *the collection* rather than its first row, so with shuffle on the
 * permutation picks the opener.
 *
 * `playFromFavorites` and not `playFromPlaylist`: this is not a playlist, so
 * `playingPlaylistId` clears and the crossfade reverts to the global setting.
 */
function playFavorites(): void {
  void playback.playFromFavorites({})
}

const model = createPlaylistRail({
  playlists: () => playlists.list,
  openIds: () => playlists.openIds,
  viewedId: () => playlists.viewedPlaylistId,
  // The other half of the §5 split, read from the controller that owns it.
  playingId: () => playback.playingPlaylistId,
  confirmDelete: () => settings.get<boolean>(CONFIRM_PLAYLIST_DELETE_KEY),
  commands: {
    open: (playlistId) => playlists.openTab(playlistId),
    create: (name) => playlists.create(name),
    rename: (playlistId, name) => playlists.rename(playlistId, name),
    remove: (playlistId) => playlists.remove(playlistId),
    reorder: (playlistId, toIndex) => playlists.reorder(playlistId, toIndex),
    play
  }
})

/**
 * §5 rule 3: this is what makes a playlist the playing one, and the crossfade
 * travels with it because the playing playlist's own value is what the scheduler
 * reads for a boundary.
 *
 * The whole playlist, with no row named and no track in hand — the one call
 * shape that does not need the rail to know what is in a playlist it has never
 * opened. Omitting the index is what makes it the *playlist* rather than its
 * first entry: with shuffle on, the permutation picks the opener instead of the
 * first row playing and everything else being shuffled behind it.
 */
function play(playlist: Playlist): void {
  void playback.playFromPlaylist({ playlistId: playlist.id })
}

const ROW_PX = 32
const scrollTop = ref(0)
const viewportPx = ref(0)
const listEl = ref<HTMLElement | null>(null)
const rowEls = new Map<number, HTMLElement>()
const renameInput = ref<HTMLInputElement | null>(null)

const window = computed(() =>
  visibleRange({
    total: model.rows.value.length,
    rowPx: ROW_PX,
    viewportPx: viewportPx.value,
    scrollTop: scrollTop.value
  })
)

const drawn = computed(() => model.rows.value.slice(window.value.first, window.value.last + 1))

function onScroll(): void {
  const element = listEl.value
  if (element === null) return
  scrollTop.value = element.scrollTop
  viewportPx.value = element.clientHeight
}

function measure(element: unknown): void {
  listEl.value = element instanceof HTMLElement ? element : null
  if (listEl.value !== null) viewportPx.value = listEl.value.clientHeight
}

function registerRow(playlistId: number, el: unknown): void {
  if (el instanceof HTMLElement) rowEls.set(playlistId, el)
  else rowEls.delete(playlistId)
}

function registerRenameInput(el: unknown): void {
  renameInput.value = el instanceof HTMLInputElement ? el : null
}

/**
 * Keeps the focused row on screen, and reachable.
 *
 * A virtualized list can focus a row that is not rendered, so the scroll is
 * computed from the index rather than delegated to `scrollIntoView` on an
 * element that may not exist yet. Arithmetic first, then the element once the
 * render that follows it has happened.
 */
async function followFocus(): Promise<void> {
  const index = model.focusIndex.value
  const element = listEl.value
  if (index === -1 || element === null) return

  const top = index * ROW_PX
  if (top < element.scrollTop) element.scrollTop = top
  else if (top + ROW_PX > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + ROW_PX - element.clientHeight
  }
  onScroll()

  await nextTick()
  const id = model.focusedId.value
  if (id !== null) rowEls.get(id)?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  const action = model.onKeydown(event)
  if (action === 'none') return
  event.preventDefault()
  if (action === 'navigate') void followFocus()
}

/** Which side of the row's midpoint the pointer fell on decides which edge it drops against. */
function sideOf(event: DragEvent, el: HTMLElement): DropSide {
  const box = el.getBoundingClientRect()
  return event.clientY < box.top + box.height / 2 ? 'before' : 'after'
}

function onDragStart(event: DragEvent, playlistId: number): void {
  model.beginDrag(playlistId)
  if (event.dataTransfer === null) return
  event.dataTransfer.effectAllowed = 'move'
  // Chromium cancels a drag that carries no payload at all.
  event.dataTransfer.setData('text/plain', String(playlistId))
}

function onDragOver(event: DragEvent, playlistId: number): void {
  const el = rowEls.get(playlistId)
  if (el === undefined) return
  // Claimed only when this rail started the drag, so a track selection dragged
  // in from a library list falls through rather than being read as a reorder.
  if (!model.dragOver(playlistId, sideOf(event, el))) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
}

function menu(playlist: Playlist): ContextMenuItem[] {
  return [
    {
      label: 'Show',
      icon: 'i-tabler-eye',
      onSelect: () => model.activate(playlist.id)
    },
    {
      label: 'Play',
      icon: 'i-tabler-player-play',
      onSelect: () => model.play(playlist.id)
    },
    { type: 'separator' },
    {
      label: 'Rename',
      icon: 'i-tabler-cursor-text',
      onSelect: () => model.beginRename(playlist.id)
    },
    {
      label: 'Delete',
      icon: 'i-tabler-trash',
      color: 'error',
      onSelect: () => void model.requestDelete(playlist.id)
    }
  ]
}

const prompt = computed(() => model.deletePrompt.value)
const promptOpen = computed({
  get: () => prompt.value !== null,
  // Dismissing the dialog any other way — Escape, the close button, a click
  // outside — has to mean the same thing as pressing Keep.
  set: (open: boolean) => {
    if (!open) model.cancelDelete()
  }
})

// The input is created by the render that follows `renamingId`, not by the click
// that set it, so selecting its text waits a tick.
watch(model.renamingId, async (id) => {
  if (id === null) return
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
})

onMounted(() => {
  void playlists.refresh()
})
</script>

<template>
  <section class="flex h-full min-h-0 flex-col" aria-label="Curate">
    <!--
      The two pinned destinations. Above the playlists and outside the scroll
      container, so they stay put however far the rail is scrolled — pinned is
      the whole of what the operator asked for.

      A `button`, not a `role="option"` in the listbox below: neither is one of
      the rail's rows and must not be arrowed into, dragged, or counted by the
      reorder. Tab reaches them; the listbox is its own stop.

      Note what is *not* here. No `UContextMenu`, so there is no Rename and no
      Delete to grey out. No `draggable`, no `dragover`, no drop indicator. Those
      are absences rather than disabled controls, which is what D18 asked for and
      also the only version that cannot rot: there is no code path to forget to
      keep disabled.
    -->
    <button
      type="button"
      class="flex h-8 shrink-0 cursor-default items-center gap-2 border-b border-default px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
      :class="
        discoverViewed
          ? 'bg-elevated text-highlighted shadow-[inset_2px_0_0_0_var(--ui-primary)]'
          : 'text-muted hover:bg-elevated/60 hover:text-default'
      "
      :aria-current="discoverViewed ? 'true' : undefined"
      @click="playlists.view(DISCOVER_TAB)"
    >
      <UIcon
        name="i-tabler-compass"
        class="size-3.5 shrink-0"
        :class="discoverViewed ? 'text-primary' : ''"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate font-medium">Discover</span>
    </button>

    <button
      type="button"
      class="flex h-8 shrink-0 cursor-default items-center gap-2 border-b border-default px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
      :class="
        favoritesViewed
          ? 'bg-elevated text-highlighted shadow-[inset_2px_0_0_0_var(--ui-primary)]'
          : 'text-muted hover:bg-elevated/60 hover:text-default'
      "
      :aria-current="favoritesViewed ? 'true' : undefined"
      @click="playlists.view(FAVORITES_TAB)"
      @dblclick="playFavorites()"
    >
      <UIcon
        name="i-tabler-heart"
        class="size-3.5 shrink-0"
        :class="favoritesViewed ? 'text-primary' : ''"
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1 truncate font-medium">My Favorites</span>
      <span class="shrink-0 text-xs tabular-nums text-dimmed">
        {{ favorites.total.toLocaleString() }}
      </span>
    </button>

    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon name="i-tabler-playlist" class="size-4 text-primary" />
      <h2 class="text-sm font-semibold text-highlighted">Playlists</h2>
      <span class="ml-auto text-xs tabular-nums text-muted">
        {{ playlists.list.length.toLocaleString() }}
      </span>
      <UButton
        icon="i-tabler-plus"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="New playlist"
        @click="model.create()"
      />
    </div>

    <!--
      One scroll container, two spacers, and only the rows between them. The
      playlists are in memory, so the whole of the virtualization is the padding.
    -->
    <div
      v-if="model.rows.value.length > 0"
      :ref="measure"
      class="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      role="listbox"
      aria-label="All playlists"
      @scroll.passive="onScroll"
      @keydown="onKeydown"
    >
      <div :style="{ height: `${window.topPx}px` }" aria-hidden="true" />

      <UContextMenu v-for="row in drawn" :key="row.playlist.id" :items="menu(row.playlist)">
        <div
          :ref="(el) => registerRow(row.playlist.id, el)"
          role="option"
          :aria-selected="row.isViewed"
          :tabindex="row.isFocused ? 0 : -1"
          :draggable="model.renamingId.value !== row.playlist.id"
          :style="{ height: `${ROW_PX}px` }"
          class="group relative flex cursor-default items-center gap-2 px-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="
            row.isViewed
              ? 'bg-elevated text-highlighted shadow-[inset_2px_0_0_0_var(--ui-primary)]'
              : 'text-muted hover:bg-elevated/60 hover:text-default'
          "
          @click="model.activate(row.playlist.id)"
          @dblclick="model.play(row.playlist.id)"
          @dragstart="onDragStart($event, row.playlist.id)"
          @dragover="onDragOver($event, row.playlist.id)"
          @drop.prevent="model.drop()"
          @dragend="model.endDrag()"
        >
          <span
            v-if="model.dropIndicator(row.playlist.id) !== null"
            class="pointer-events-none absolute inset-x-0 h-0.5 bg-primary"
            :class="model.dropIndicator(row.playlist.id) === 'before' ? 'top-0' : 'bottom-0'"
            aria-hidden="true"
          />

          <!--
            Two states, two marks, because §5 makes them two facts. Playing gets
            the glyph; viewed is the row's own surface and the primary edge. A
            third "open" mark used to sit here when this rail fed a tab strip;
            without one, viewed is the only workspace fact a row has.
          -->
          <UIcon
            v-if="row.isPlaying"
            name="i-tabler-player-play-filled"
            class="size-3 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span v-else class="size-3 shrink-0" aria-hidden="true" />

          <input
            v-if="model.renamingId.value === row.playlist.id"
            :ref="(el) => registerRenameInput(el)"
            v-model="model.draft.value"
            class="min-w-0 flex-1 rounded-sm bg-default px-1 text-sm text-highlighted outline-none ring-1 ring-primary"
            :maxlength="PLAYLIST_NAME_MAX_LENGTH"
            aria-label="Playlist name"
            @click.stop
            @dblclick.stop
            @keydown.stop.enter.prevent="model.commitRename()"
            @keydown.stop.esc.prevent="model.cancelRename()"
            @blur="model.commitRename()"
          />
          <template v-else>
            <span
              class="min-w-0 flex-1 truncate"
              :class="row.isPlaying ? 'text-primary' : ''"
              :title="row.playlist.name"
            >
              {{ row.playlist.name }}
            </span>
            <span v-if="row.isPlaying" class="sr-only">(playing)</span>
            <span class="shrink-0 text-xs tabular-nums text-dimmed">
              {{ row.playlist.trackCount.toLocaleString() }}
            </span>
          </template>
        </div>
      </UContextMenu>

      <div :style="{ height: `${window.bottomPx}px` }" aria-hidden="true" />
    </div>

    <UEmpty
      v-else
      variant="naked"
      size="sm"
      icon="i-tabler-playlist-add"
      title="No playlists yet"
      description="Make one with the plus button."
      class="min-h-0 flex-1"
    />

    <UModal
      v-model:open="promptOpen"
      :title="prompt?.title ?? ''"
      :description="prompt?.message ?? ''"
      :ui="{ footer: 'justify-end' }"
    >
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="model.cancelDelete()">Keep</UButton>
        <UButton
          :color="prompt?.stopsPlayback ? 'error' : 'primary'"
          icon="i-tabler-trash"
          @click="model.confirmDelete()"
        >
          Delete
        </UButton>
      </template>
    </UModal>
  </section>
</template>
