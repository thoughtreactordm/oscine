<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import AppTitleBar from '@renderer/panels/AppTitleBar.vue'
import NowPlaying from '@renderer/panels/NowPlaying.vue'
import Sources from '@renderer/panels/Sources.vue'
import TrackList from '@renderer/panels/TrackList.vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useTrackListStore } from '@renderer/stores/trackList'
import type { LibraryBrowseFilters, Track } from '@shared/library'

/**
 * Fixed M3 shell.
 *
 * This component owns only placement and the narrow messages that cross island
 * boundaries. Sources declares a browse predicate, TrackList renders it, and
 * activation captures that predicate for NowPlaying's traversal.
 */
const trackList = useTrackListStore()
const playback = usePlaybackStore()
const sources = ref<InstanceType<typeof Sources> | null>(null)

function browse(filters: LibraryBrowseFilters): void {
  trackList.setFilters(filters)
}

function playTrack(track: Track, index: number): void {
  void playback.playFromList({
    sort: trackList.sort,
    direction: trackList.direction,
    filters: trackList.filters,
    index,
    track
  })
}

onUnmounted(() => playback.dispose())
</script>

<template>
  <main
    class="grid h-screen grid-rows-[2.25rem_minmax(0,1fr)_5rem] overflow-hidden bg-border text-default"
  >
    <AppTitleBar @add-folder="sources?.addFolder()" />

    <div class="relative min-h-0 overflow-hidden">
      <UDashboardGroup
        unit="px"
        :persistent="false"
        class="gap-px"
        :ui="{ base: 'absolute inset-0' }"
        storage-key="fermata-library-shell"
      >
        <UDashboardPanel
          id="sources"
          :default-size="320"
          :min-size="240"
          :max-size="480"
          resizable
          class="min-h-0 min-w-60 bg-default"
        >
          <Sources ref="sources" @filters-change="browse" @library-change="trackList.reload()" />
        </UDashboardPanel>

        <UDashboardPanel id="songs" class="min-h-0 min-w-120 flex-1 bg-default">
          <section class="flex h-full min-h-0 min-w-0 flex-col" aria-label="Songs">
            <div
              class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2"
            >
              <UIcon name="i-lucide-list-music" class="size-4 text-primary" />
              <h2 class="font-semibold text-highlighted">Songs</h2>
              <span class="ml-auto text-xs tabular-nums text-muted">
                {{ trackList.total.toLocaleString() }}
              </span>
            </div>
            <div class="min-h-0 flex-1">
              <TrackList @activate="playTrack" />
            </div>
          </section>
        </UDashboardPanel>
      </UDashboardGroup>
    </div>

    <div class="min-h-0 border-t border-default bg-default">
      <NowPlaying />
    </div>
  </main>
</template>
