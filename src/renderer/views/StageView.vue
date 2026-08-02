<script setup lang="ts">
import { computed } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import WaveformRibbon from '@renderer/panels/WaveformRibbon.vue'

/**
 * The Now Playing tab: one record, as large as the window allows.
 *
 * The only tab the frame draws without a sidebar. That is the whole point of it
 * — nothing to browse, nothing to choose, just what is playing — so it declares
 * `sidebar: false` in the route table and gets the full width.
 *
 * Transport stays where it always is, in the bar below. A second set of
 * controls here would be a second source of truth for the same three buttons.
 */
const playback = usePlaybackStore()

const cover = computed(() => playback.nowPlaying?.artwork.large ?? null)

/** Alt text describes the record, not the file: an empty alt for no record. */
const label = computed(() => {
  const track = playback.nowPlaying
  if (!track) return ''
  return track.album ? `Cover art for ${track.album}` : `Cover art for ${track.title}`
})

const byline = computed(() => {
  const track = playback.nowPlaying
  if (!track) return null
  return track.artist ?? track.albumArtist
})
</script>

<template>
  <section
    class="relative flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-default"
    aria-label="Now playing"
  >
    <!--
      The art again, blown out and blurred, as the backdrop. It is the one
      colour source on this screen that is allowed to come from outside the
      token layer, because it is not a colour — it is the artwork itself.
    -->
    <Transition name="stage-wash">
      <img
        v-if="cover"
        :key="cover"
        :src="cover"
        alt=""
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-20 blur-3xl"
        draggable="false"
      />
    </Transition>

    <div class="relative flex min-h-0 flex-col items-center gap-6 p-8">
      <!--
        Sized by height here, not width: the stage is as wide as the window and
        the constraint that actually bites is the one between the tab row and
        the transport bar.
      -->
      <div
        class="aspect-square h-[min(60vh,60vw)] overflow-hidden rounded-xl border border-default bg-elevated shadow-2xl"
      >
        <Transition name="stage-art" mode="out-in">
          <img
            v-if="cover"
            :key="cover"
            :src="cover"
            :alt="label"
            class="size-full object-cover"
            draggable="false"
          />
          <div v-else class="flex size-full items-center justify-center">
            <UIcon name="i-tabler-vinyl" class="size-24 text-dimmed" />
          </div>
        </Transition>
      </div>

      <div v-if="playback.hasTrack" class="flex max-w-2xl flex-col items-center gap-1 text-center">
        <h2 class="truncate text-2xl font-bold tracking-tight text-highlighted">
          {{ playback.nowPlaying?.title }}
        </h2>
        <p v-if="byline" class="truncate text-base text-muted">{{ byline }}</p>
        <p v-if="playback.nowPlaying?.album" class="truncate text-sm text-dimmed">
          {{ playback.nowPlaying.album }}
        </p>
      </div>
      <p v-else class="text-sm text-dimmed">Nothing playing</p>
    </div>

    <!--
      Last child, so it stacks over the wash and the record without needing a
      z-index of its own. It only exists on this route: the loop is bounded by
      the component's lifetime, and leaving the tab is what stops it.
    -->
    <WaveformRibbon />
  </section>
</template>

<style scoped>
.stage-art-enter-active,
.stage-art-leave-active,
.stage-wash-enter-active,
.stage-wash-leave-active {
  transition:
    opacity 300ms ease,
    filter 300ms ease;
}

.stage-art-enter-from,
.stage-art-leave-to {
  opacity: 0;
  filter: blur(60px);
}

.stage-wash-enter-from,
.stage-wash-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .stage-art-enter-active,
  .stage-art-leave-active,
  .stage-wash-enter-active,
  .stage-wash-leave-active {
    transition-duration: 120ms;
  }
}
</style>
