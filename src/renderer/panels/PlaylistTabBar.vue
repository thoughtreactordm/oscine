<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  createPlaylistTabs,
  PLAYLIST_NAME_MAX_LENGTH,
  type DropSide
} from '@renderer/panels/playlistTabs'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'

/**
 * D5's backbone, made visible.
 *
 * Two states are drawn, and they are drawn *differently* on purpose. The viewed
 * tab is the one whose surface lifts out of the strip; the playing tab is the
 * one wearing a primary glyph and a primary label. §5 makes those separate
 * facts, so an operator who has arrowed three tabs away from what is playing can
 * still see, without clicking anything, where the sound is coming from. One
 * shared highlight for both would have hidden the split in exactly the situation
 * that proves it exists.
 *
 * Not virtualized, and that is the one place this file departs from the
 * every-list-is-virtualized invariant. The invariant's scale target is 100k
 * tracks; tabs are a handful of rows the operator typed by hand, and the main
 * process has already committed to that reading — `PlaylistStore.reorder`
 * renumbers every tab in the bar inside one transaction, which is a design that
 * only works because the bar is small. Virtualizing a horizontal strip whose
 * width is bounded by what a human named would buy nothing and would cost the
 * scroll-into-view that keyboard navigation needs.
 *
 * D4 island rules: nothing below the strip is assumed. The contents pane (W5-6)
 * is a sibling, not a child, so docking either one elsewhere touches neither.
 */

const playlists = usePlaylistsStore()
const playback = usePlaybackStore()

const model = createPlaylistTabs({
  tabs: () => playlists.list,
  viewedId: () => playlists.viewedPlaylistId,
  // The other half of the §5 split, read from the controller that owns it.
  playingId: () => playback.playingPlaylistId,
  commands: {
    view: (playlistId) => playlists.view(playlistId),
    create: (name) => playlists.create(name),
    rename: (playlistId, name) => playlists.rename(playlistId, name),
    remove: (playlistId) => playlists.remove(playlistId),
    reorder: (playlistId, toIndex) => playlists.reorder(playlistId, toIndex)
  }
})

const tabEls = new Map<number, HTMLElement>()
const renameInput = ref<HTMLInputElement | null>(null)

// Function refs rather than named ones: both of these live inside the `v-for`,
// where a string ref collects into an array whose order is not the bar's.
function registerTab(playlistId: number, el: unknown): void {
  if (el instanceof HTMLElement) tabEls.set(playlistId, el)
  else tabEls.delete(playlistId)
}

function registerRenameInput(el: unknown): void {
  renameInput.value = el instanceof HTMLInputElement ? el : null
}

/**
 * Which tab the Tab key reaches: only the viewed one, so the strip is a single
 * stop and the arrows do the walking inside it. `scrollIntoView` is here rather
 * than in the model because arrowing past the edge of an overflowing bar is
 * otherwise a selection the operator cannot see.
 */
async function focusViewed(): Promise<void> {
  await nextTick()
  const id = playlists.viewedPlaylistId
  if (id === null) return
  const el = tabEls.get(id)
  el?.focus()
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onKeydown(event: KeyboardEvent): void {
  const action = model.onKeydown(event)
  if (action === 'none') return
  event.preventDefault()
  if (action === 'navigate') void focusViewed()
}

/** Which side of the tab's midpoint the pointer fell on decides which edge it drops against. */
function sideOf(event: DragEvent, el: HTMLElement): DropSide {
  const box = el.getBoundingClientRect()
  return event.clientX < box.left + box.width / 2 ? 'before' : 'after'
}

function onDragStart(event: DragEvent, playlistId: number): void {
  model.beginDrag(playlistId)
  if (event.dataTransfer === null) return
  event.dataTransfer.effectAllowed = 'move'
  // Chromium cancels a drag that carries no payload at all.
  event.dataTransfer.setData('text/plain', String(playlistId))
}

function onDragOver(event: DragEvent, playlistId: number): void {
  const el = tabEls.get(playlistId)
  if (el === undefined) return
  // Claimed only when this strip started the drag. A track selection dragged in
  // from the library is W5-5's gesture and has to fall through to whatever is
  // listening for it.
  if (!model.dragOver(playlistId, sideOf(event, el))) return
  event.preventDefault()
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
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
  <div class="flex shrink-0 flex-col">
    <div class="flex h-9 items-stretch border-b border-default bg-elevated/40">
      <div
        class="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        role="tablist"
        aria-label="Playlists"
        aria-orientation="horizontal"
        @keydown="onKeydown"
      >
        <div
          v-for="tab in model.tabs.value"
          :key="tab.id"
          :ref="(el) => registerTab(tab.id, el)"
          role="tab"
          :aria-selected="model.isViewed(tab.id)"
          :tabindex="model.isViewed(tab.id) ? 0 : -1"
          :draggable="model.renamingId.value !== tab.id"
          class="group relative flex max-w-56 shrink-0 cursor-default items-center gap-1.5 border-r border-default px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="
            model.isViewed(tab.id)
              ? 'bg-default text-highlighted shadow-[inset_0_-2px_0_0_var(--ui-primary)]'
              : 'text-muted hover:bg-elevated/70 hover:text-default'
          "
          @click="model.select(tab.id)"
          @dblclick="model.beginRename(tab.id)"
          @dragstart="onDragStart($event, tab.id)"
          @dragover="onDragOver($event, tab.id)"
          @drop.prevent="model.drop()"
          @dragend="model.endDrag()"
        >
          <!-- Its own element rather than another `shadow-[…]`: two arbitrary
               shadows on one tab would be the same CSS property twice, and which
               one won would depend on stylesheet order. -->
          <span
            v-if="model.dropIndicator(tab.id) !== null"
            class="pointer-events-none absolute inset-y-0 w-0.5 bg-primary"
            :class="model.dropIndicator(tab.id) === 'before' ? 'left-0' : 'right-0'"
            aria-hidden="true"
          />

          <!-- The playing mark: a different signal from the viewed surface, per §5. -->
          <UIcon
            v-if="model.isPlaying(tab.id)"
            name="i-tabler-player-play-filled"
            class="size-3 shrink-0 text-primary"
            aria-hidden="true"
          />

          <input
            v-if="model.renamingId.value === tab.id"
            :ref="(el) => registerRenameInput(el)"
            v-model="model.draft.value"
            class="w-32 min-w-0 rounded-sm bg-elevated px-1 text-sm text-highlighted outline-none ring-1 ring-primary"
            :maxlength="PLAYLIST_NAME_MAX_LENGTH"
            aria-label="Playlist name"
            @keydown.enter.prevent="model.commitRename()"
            @keydown.esc.prevent="model.cancelRename()"
            @blur="model.commitRename()"
          />
          <template v-else>
            <span
              class="truncate"
              :class="model.isPlaying(tab.id) ? 'text-primary' : ''"
              :title="tab.name"
            >
              {{ tab.name }}
            </span>
            <span v-if="model.isPlaying(tab.id)" class="sr-only">(playing)</span>
            <span class="shrink-0 text-xs tabular-nums text-dimmed">{{ tab.trackCount }}</span>
          </template>

          <UButton
            icon="i-tabler-x"
            size="xs"
            color="neutral"
            variant="ghost"
            class="shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            :class="model.isViewed(tab.id) ? 'opacity-100' : ''"
            :aria-label="`Close ${tab.name}`"
            tabindex="-1"
            draggable="false"
            @click.stop="model.requestDelete(tab.id)"
          />
        </div>
      </div>

      <p v-if="model.tabs.value.length === 0" class="self-center px-2.5 text-xs text-muted">
        No playlists yet.
      </p>

      <!-- Outside the tablist: a tablist may only contain tabs. -->
      <UButton
        icon="i-tabler-plus"
        size="xs"
        color="neutral"
        variant="ghost"
        class="mx-1 shrink-0 self-center"
        aria-label="New playlist"
        @click="model.createTab()"
      />
    </div>

    <UAlert
      v-if="playlists.notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="playlists.notice"
      class="rounded-none"
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
  </div>
</template>
