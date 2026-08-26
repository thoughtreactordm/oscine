<script setup lang="ts">
import PodcastDiscoverPane from '@renderer/panels/PodcastDiscoverPane.vue'
import PodcastShowPane from '@renderer/panels/PodcastShowPane.vue'
import { PODCAST_DISCOVER_TAB, usePodcastsStore } from '@renderer/stores/podcasts'

/**
 * Podcasts body: Discover or the viewed show. The left rail next door is what
 * picks which — there is no second chooser in this pane.
 *
 * Same island split as Curate — the rail wrote `viewedPodcastId` before this
 * pane existed and does not know it now has a reader; they meet at the store.
 *
 * Notices used to sit on the tab strip. They belong here now that the strip is
 * gone, so a failed download or a failed refresh still has somewhere to land.
 */

const podcasts = usePodcastsStore()
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Podcasts">
    <UAlert
      v-if="podcasts.notice"
      color="warning"
      variant="subtle"
      icon="i-tabler-alert-triangle"
      :description="podcasts.notice"
      class="rounded-none"
    />

    <div class="min-h-0 flex-1">
      <PodcastDiscoverPane v-if="podcasts.viewedPodcastId === PODCAST_DISCOVER_TAB" />
      <PodcastShowPane v-else />
    </div>
  </section>
</template>
