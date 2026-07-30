<script setup lang="ts">
import { computed } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'

/**
 * The cover blow-up.
 *
 * An island like the rest: it reads the playback store for what is loaded and
 * the shell store for whether it is wanted, and knows nothing about the facets
 * it happens to sit under. `large` rather than `small` because this is the one
 * view where the art is the subject rather than a label for a row.
 */
const playback = usePlaybackStore()
const shell = useShellStore()

const cover = computed(() => playback.nowPlaying?.artwork.large ?? null)

/**
 * Alt text describing the record, not the image. A cover with no album to name
 * is decoration, and an empty alt is what tells a screen reader to skip it
 * rather than read a URL.
 */
const label = computed(() => {
  const track = playback.nowPlaying
  if (!track) return ''
  return track.album ? `Cover art for ${track.album}` : `Cover art for ${track.title}`
})
</script>

<template>
  <section class="flex shrink-0 flex-col border-t border-default" aria-label="Cover art">
    <div class="flex h-8 shrink-0 items-center gap-2 border-b border-default bg-elevated/30 px-2">
      <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">Cover</h2>
      <UButton
        class="ml-auto"
        icon="i-tabler-x"
        size="xs"
        color="neutral"
        variant="ghost"
        aria-label="Hide cover art"
        @click="shell.collapseCover()"
      />
    </div>

    <div class="p-3">
      <!--
        Sized by width, never by height: `min(100%, 40vh)` keeps the square
        inside the sidebar however wide the user has dragged it, and off the
        facet lists above however short the window is. An `aspect-square` box
        with a `max-height` would be clamped on one axis only and stop being
        square; clamping the width instead leaves both axes agreeing.
      -->
      <div
        class="mx-auto aspect-square w-[min(100%,40vh)] overflow-hidden rounded-md border border-default bg-elevated"
      >
        <Transition name="cover-art" mode="out-in">
          <img
            v-if="cover"
            :key="cover"
            :src="cover"
            :alt="label"
            class="size-full object-cover"
            draggable="false"
          />
          <div v-else class="flex size-full items-center justify-center">
            <UIcon name="i-tabler-vinyl" class="size-10 text-dimmed" />
          </div>
        </Transition>
      </div>

      <p v-if="playback.hasTrack" class="mt-2 truncate text-center text-sm text-highlighted">
        {{ playback.nowPlaying?.title }}
      </p>
      <p v-if="playback.hasTrack" class="truncate text-center text-xs text-muted">
        {{ playback.nowPlaying?.albumArtist ?? playback.nowPlaying?.album }}
      </p>
      <p v-else class="mt-2 text-center text-xs text-dimmed">Nothing playing</p>
    </div>
  </section>
</template>

<style scoped>
.cover-art-enter-active,
.cover-art-leave-active {
  transition: opacity 300ms ease;
}

.cover-art-enter-from,
.cover-art-leave-to {
  opacity: 0;
  filter: blur(60px);
}

@media (prefers-reduced-motion: reduce) {
  .cover-art-enter-active,
  .cover-art-leave-active {
    transition-duration: 120ms;
  }
}
</style>
