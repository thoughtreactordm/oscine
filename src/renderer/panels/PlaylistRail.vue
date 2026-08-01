<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import { visibleRange } from '@renderer/panels/listViewport'
import { createPlaylistRail, PLAYLIST_NAME_MAX_LENGTH } from '@renderer/panels/playlistRail'
import type { DropSide } from '@renderer/panels/playlistReorder'
import { useSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import type { Playlist } from '@shared/playlists'
import { CONFIRM_PLAYLIST_DELETE_KEY } from '@shared/settings'

/**
 * Every playlist, in the Curate sidebar.
 *
 * This is the half of D5 that was missing. The strip is the backbone and stays
 * the backbone, but a backbone made of *every* playlist has no closed state, so
 * its close button had to be a delete. The rail is where a closed playlist
 * lives: click to open it, double-click to play it, and the strip is free to be
 * just the few you are working on.
 *
 * Virtualized, per the standing invariant and unlike the strip. The strip holds
 * what one operator opened by hand; this holds however many playlists exist, and
 * a rail that rendered two hundred rows to show twelve is the same mistake as a
 * track list that renders 100k. `listViewport` and nothing else — the playlists
 * are already in memory, so there is nothing to page and what is left is
 * arithmetic.
 *
 * D4 island rules: it imports no sibling panel and holds no reference to the
 * strip or the contents pane. All three meet at the store.
 */

const playlists = usePlaylistsStore()
const playback = usePlaybackStore()
const settings = useSettings()

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
 * From the top, with no track in hand — `playFromPlaylist` resolves position 0
 * itself, which is the one call shape that does not need the rail to know what
 * is in a playlist it has never opened.
 */
function play(playlist: Playlist): void {
  void playback.playFromPlaylist({
    playlistId: playlist.id,
    index: 0
  })
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
      label: model.isOpen(playlist.id) ? 'Go to tab' : 'Open in a tab',
      icon: 'i-tabler-external-link',
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
  <section class="flex h-full min-h-0 flex-col" aria-label="Playlists">
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
            Three states, three marks, because §5 makes them three facts. Playing
            gets the glyph; open gets a dot, so a tab you left behind is visible
            from here; viewed is the row's own surface and the primary edge.
          -->
          <UIcon
            v-if="row.isPlaying"
            name="i-tabler-player-play-filled"
            class="size-3 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span
            v-else-if="row.isOpen"
            class="size-1.5 shrink-0 rounded-full bg-primary/70"
            aria-hidden="true"
          />
          <span v-else class="size-1.5 shrink-0" aria-hidden="true" />

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
            <span v-if="row.isOpen" class="sr-only">(open)</span>
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
