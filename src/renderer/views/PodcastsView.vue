<script setup lang="ts">
import PodcastDiscoverPane from '@renderer/panels/PodcastDiscoverPane.vue'
import PodcastShowPane from '@renderer/panels/PodcastShowPane.vue'
import PodcastTabBar from '@renderer/panels/PodcastTabBar.vue'
import { PODCAST_DISCOVER_TAB, usePodcastsStore } from '@renderer/stores/podcasts'

/**
 * Podcasts body: tab strip + Discover or the viewed show.
 *
 * Same island split as Curate — strip and body share the store, not each other.
 * Notices live on the strip (`PodcastTabBar`), matching Curate.
 */

const podcasts = usePodcastsStore()
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Podcasts">
    <PodcastTabBar />

    <div class="min-h-0 flex-1">
      <PodcastDiscoverPane v-if="podcasts.viewedPodcastId === PODCAST_DISCOVER_TAB" />
      <PodcastShowPane v-else />
    </div>
  </section>
</template>
