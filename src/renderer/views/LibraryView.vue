<script setup lang="ts">
import { computed } from 'vue'
import ColumnChooser from '@renderer/panels/ColumnChooser.vue'
import GroupChooser from '@renderer/panels/GroupChooser.vue'
import TrackList from '@renderer/panels/TrackList.vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useTrackColumnsStore } from '@renderer/stores/columns'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { Track } from '@shared/library'

/**
 * The Library tab's body: the song list and the chrome that describes it.
 *
 * The predicate it renders is written to the track list store by `Sources`,
 * which the frame mounts as this tab's sidebar. The two are siblings under a
 * routed layout now rather than parent and child, so the store carries what the
 * `filters-change` emit used to.
 */
const trackList = useTrackListStore()
const columns = useTrackColumnsStore()
const playback = usePlaybackStore()

/**
 * The ordering, shown only when its column is not.
 *
 * A hidden sort column still orders the list, and with no header to carry the
 * arrow the state would otherwise be invisible — the user would see a list
 * sorted by something with no way to tell what. The chooser is where it is
 * changed; this is where it is read.
 */
const hiddenSort = computed(() =>
  columns.isVisible(trackList.sort) ? null : columns.specOf(trackList.sort)
)

function playTrack(track: Track, index: number): void {
  void playback.playFromList({
    sort: trackList.sort,
    direction: trackList.direction,
    filters: trackList.filters,
    index,
    track
  })
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col" aria-label="Songs">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon name="i-tabler-playlist" class="size-4 text-primary" />
      <h2 class="font-semibold text-highlighted">Songs</h2>

      <UBadge
        v-if="hiddenSort"
        color="neutral"
        variant="subtle"
        size="sm"
        :icon="trackList.direction === 'asc' ? 'i-tabler-chevron-up' : 'i-tabler-chevron-down'"
      >
        {{ hiddenSort.title ?? hiddenSort.label }}
      </UBadge>

      <span
        v-if="trackList.selectionCount > 0"
        class="ml-auto text-xs tabular-nums text-primary"
        aria-live="polite"
      >
        {{ trackList.selectionCount.toLocaleString() }} selected
      </span>
      <span
        class="text-xs tabular-nums text-muted"
        :class="{ 'ml-auto': trackList.selectionCount === 0 }"
      >
        {{ trackList.total.toLocaleString() }}
      </span>

      <GroupChooser />
      <ColumnChooser />
    </div>
    <div class="min-h-0 flex-1">
      <TrackList @activate="playTrack" />
    </div>
  </section>
</template>
