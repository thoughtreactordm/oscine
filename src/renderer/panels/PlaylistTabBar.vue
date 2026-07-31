<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import {
  createPlaylistTabs,
  DISCOVER_TAB,
  PLAYLIST_NAME_MAX_LENGTH,
  type TabStop
} from '@renderer/panels/playlistTabs'
import type { DropSide } from '@renderer/panels/playlistReorder'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistsStore } from '@renderer/stores/playlists'

/**
 * D5's backbone, made visible: Discover, then the playlists that are *open*.
 *
 * It used to draw every playlist, which made its close button a delete — there
 * was nowhere for a closed playlist to go. `PlaylistRail` is that somewhere now,
 * so this strip opens nothing, deletes nothing, and closing a tab is free.
 *
 * Discover is a fixture rather than a tab that happens to always be there. It
 * carries no close button, no rename, no drag handle and no track count, and it
 * is `DISCOVER_TAB` — `null` — everywhere the other tabs are an id, which is
 * what keeps every destructive verb in this file unable to name it.
 *
 * Two states are drawn, and they are drawn *differently* on purpose. The viewed
 * tab is the one whose surface lifts out of the strip; the playing tab is the
 * one wearing a primary glyph and a primary label. §5 makes those separate
 * facts, so an operator who has arrowed three tabs away from what is playing can
 * still see, without clicking anything, where the sound is coming from. One
 * shared highlight for both would have hidden the split in exactly the situation
 * that proves it exists.
 *
 * Not virtualized, and that is where this file departs from the
 * every-list-is-virtualized invariant. The invariant's scale target is 100k
 * tracks; the strip holds what one operator opened by hand, and the rail beside
 * it — which *is* virtualized, because it holds every playlist — is where the
 * unbounded list actually lives. Virtualizing a horizontal strip whose width is
 * bounded by a person's attention would buy nothing and would cost the
 * scroll-into-view that keyboard navigation needs.
 *
 * D4 island rules: nothing below the strip is assumed, and the rail is a
 * sibling in a different route slot that this file never imports. All three
 * meet at the store.
 */

const playlists = usePlaylistsStore()
const playback = usePlaybackStore()

const model = createPlaylistTabs({
  tabs: () => playlists.openTabs,
  viewedId: () => playlists.viewedPlaylistId,
  // The other half of the §5 split, read from the controller that owns it.
  playingId: () => playback.playingPlaylistId,
  commands: {
    view: (playlistId) => playlists.view(playlistId),
    rename: (playlistId, name) => playlists.rename(playlistId, name),
    close: (playlistId) => playlists.close(playlistId),
    moveOpen: (playlistId, toIndex) => playlists.moveOpen(playlistId, toIndex)
  }
})

const tabEls = new Map<TabStop, HTMLElement>()
const renameInput = ref<HTMLInputElement | null>(null)

// Function refs rather than named ones: both of these live inside the `v-for`,
// where a string ref collects into an array whose order is not the bar's. The
// fixture registers through the same map so focus can reach it by the same path.
function registerTab(stop: TabStop, el: unknown): void {
  if (el instanceof HTMLElement) tabEls.set(stop, el)
  else tabEls.delete(stop)
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
  const el = tabEls.get(playlists.viewedPlaylistId)
  el?.focus()
  el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onKeydown(event: KeyboardEvent): void {
  const action = model.onKeydown(event)
  if (action === 'none') return
  event.preventDefault()
  if (action === 'navigate' || action === 'close') void focusViewed()
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

// The input is created by the render that follows `renamingId`, not by the click
// that set it, so selecting its text waits a tick.
watch(model.renamingId, async (id) => {
  if (id === null) return
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
})

// Asked for even though the rail asks too: an island may not assume its
// neighbour is on screen. `refresh` coalesces, so mounting both is one query.
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
        aria-label="Open playlists"
        aria-orientation="horizontal"
        @keydown="onKeydown"
      >
        <!--
          The fixture. Same surface treatment as a viewed playlist tab so the
          strip reads as one row of tabs, and deliberately none of the affordances
          — no close, no dblclick rename, no `draggable`, no drop handlers. It is
          not draggable in the other direction either: a playlist dragged over it
          finds no `dragover` listener, so the fixture cannot be displaced from
          the left end.
        -->
        <div
          :ref="(el) => registerTab(DISCOVER_TAB, el)"
          role="tab"
          :aria-selected="model.discoverViewed.value"
          :tabindex="model.discoverViewed.value ? 0 : -1"
          class="relative flex shrink-0 cursor-default items-center gap-1.5 border-r border-default px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
          :class="
            model.discoverViewed.value
              ? 'bg-default text-highlighted shadow-[inset_0_-2px_0_0_var(--ui-primary)]'
              : 'text-muted hover:bg-elevated/70 hover:text-default'
          "
          @click="model.select(DISCOVER_TAB)"
        >
          <UIcon
            name="i-tabler-compass"
            class="size-3.5 shrink-0"
            :class="model.discoverViewed.value ? 'text-primary' : ''"
            aria-hidden="true"
          />
          <span>Discover</span>
        </div>

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
          @auxclick.middle.prevent="model.close(tab.id)"
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

          <!-- Closes the tab. It does not delete the playlist — that verb is in
               the rail, on the row that actually is the playlist. -->
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
            @click.stop="model.close(tab.id)"
          />
        </div>
      </div>

      <p v-if="model.tabs.value.length === 0" class="self-center px-2.5 text-xs text-muted">
        No playlists open. Pick one from the rail.
      </p>
    </div>

    <UAlert
      v-if="playlists.notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="playlists.notice"
      class="rounded-none"
    />
  </div>
</template>
