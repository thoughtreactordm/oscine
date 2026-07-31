<script setup lang="ts">
import { computed } from 'vue'
import type { ContextMenuItem } from '@nuxt/ui'
import { createPlaylistContents } from '@renderer/panels/playlistContents'
import TrackList from '@renderer/panels/TrackList.vue'
import { activeRowDrag, beginRowDrag, endRowDrag } from '@renderer/panels/trackDrag'
import type { TrackListDrag, TrackListMenu } from '@renderer/panels/trackListSource'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlaylistEntriesStore } from '@renderer/stores/playlistEntries'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { PLAYLIST_PATH_STYLES } from '@shared/playlists'
import type { Track } from '@shared/library'

/**
 * The pane under the tab strip: one playlist's entries.
 *
 * It is `TrackList` — the same virtualized island the library uses, handed a
 * different source — rather than a second list implementation. That was the
 * point of the card: the two lists differ in what they are *ordered by* and in
 * what a row's identity is, and neither difference is a reason to virtualize
 * 100k rows twice.
 *
 * D4 island rules, upwards as well as downwards. The strip above is a sibling
 * and this pane holds no reference to it beyond `viewedPlaylistId`, so either
 * one can be docked elsewhere without the other noticing.
 */

const playlists = usePlaylistsStore()
const entries = usePlaylistEntriesStore()
const playback = usePlaybackStore()

const model = createPlaylistContents({
  playlistId: () => entries.playlistId,
  entryIdAt: (index) => entries.entryIdAt(index),
  isSelectedAt: (index) => entries.isSelectedAt(index),
  selectionCount: () => entries.selectionCount,
  resolveSelection: () => entries.resolveSelection(),
  activeDrag: activeRowDrag,
  beginDrag: beginRowDrag,
  endDrag: endRowDrag,
  commands: {
    addTracks: (trackIds, insertion) => entries.addTracks(trackIds, insertion),
    moveEntries: (entryIds, insertion) => entries.moveEntries(entryIds, insertion),
    removeEntries: (entryIds) => entries.removeEntries(entryIds)
  }
})

/**
 * The list's drag adapter.
 *
 * "Past the last row" is drawn as a marker under the final row rather than as a
 * separate target, because in a virtualized list there is no reliable space
 * after the rows to aim at — and the bottom edge of the last row already means
 * the same thing.
 */
const drag: TrackListDrag = {
  enabled: true,
  indicatorAt: (index) =>
    model.dropIndicator(index) ??
    (model.droppingAtEnd.value && index === entries.total - 1 ? 'after' : null),
  start: (index) => model.beginDrag(index),
  over: (index, side) => model.dragOver(index, side),
  drop: () => void model.drop(),
  end: () => model.endDrag()
}

const selectionSize = computed(() => Math.max(1, entries.selectionCount))

const menu: TrackListMenu = (index): ContextMenuItem[] => {
  const many = entries.isSelectedAt(index) && entries.selectionCount > 1
  return [
    {
      label: 'Play',
      icon: 'i-tabler-player-play',
      onSelect: () => playAt(index)
    },
    {
      label: many
        ? `Remove ${selectionSize.value.toLocaleString()} entries`
        : 'Remove from playlist',
      icon: 'i-tabler-trash',
      color: 'error',
      onSelect: () => void model.remove(index)
    }
  ]
}

/**
 * The export affordance W5-4 built the seam for and deliberately left unhung.
 *
 * Per export rather than per setting, because `PlaylistPathStyle` is a real
 * choice between two defensible answers and neither camp can be talked out of
 * theirs — see the note on the constant.
 */
const exportItems = computed<ContextMenuItem[]>(() =>
  PLAYLIST_PATH_STYLES.map((style) => ({
    label: style === 'relative' ? 'Export with relative paths…' : 'Export with absolute paths…',
    icon: 'i-tabler-file-export',
    onSelect: () => {
      const playlist = playlists.viewed
      if (playlist !== null) void playlists.exportM3u8(playlist.id, style)
    }
  }))
)

function playAt(index: number): void {
  const track = entries.rowAt(index)
  if (track) play(track, index)
}

/**
 * §5 rule 3: this is what makes a playlist the playing one, and the crossfade
 * travels with it because the playing playlist's own value is what the scheduler
 * reads for a boundary.
 */
function play(track: Track, index: number): void {
  const playlist = playlists.viewed
  if (playlist === null) return
  void playback.playFromPlaylist({
    playlistId: playlist.id,
    index,
    crossfadeMs: playlist.crossfadeMs,
    track
  })
}
</script>

<template>
  <section
    v-if="playlists.viewed !== null"
    class="flex h-full min-h-0 min-w-0 flex-col"
    :aria-label="playlists.viewed.name"
  >
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon name="i-tabler-list-numbers" class="size-4 text-primary" />
      <h2 class="truncate font-semibold text-highlighted">{{ playlists.viewed.name }}</h2>

      <span
        v-if="entries.selectionCount > 0"
        class="ml-auto text-xs tabular-nums text-primary"
        aria-live="polite"
      >
        {{ entries.selectionCount.toLocaleString() }} selected
      </span>
      <span
        class="text-xs tabular-nums text-muted"
        :class="{ 'ml-auto': entries.selectionCount === 0 }"
      >
        {{ entries.total.toLocaleString() }}
      </span>

      <UDropdownMenu :items="exportItems">
        <UButton
          icon="i-tabler-dots"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="Playlist actions"
        />
      </UDropdownMenu>
    </div>

    <div class="min-h-0 flex-1">
      <TrackList
        :source="entries"
        :drag="drag"
        :menu="menu"
        :label="`${playlists.viewed.name} entries`"
        @activate="play"
      >
        <template #empty>
          <UEmpty
            variant="naked"
            icon="i-tabler-playlist-add"
            title="Nothing in this playlist yet"
            description="Drag tracks in from the library, or right-click a selection there."
            class="h-full"
          />
        </template>
      </TrackList>
    </div>
  </section>

  <UEmpty
    v-else
    variant="naked"
    icon="i-tabler-playlist-add"
    title="No playlist selected"
    description="Make one with the plus button, or pick a tab."
    class="h-full"
  />
</template>
