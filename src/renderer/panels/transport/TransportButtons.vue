<script setup lang="ts">
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * Previous / play-pause / next, with the elapsed and total time stacked above —
 * the transport's core verbs, shared by the bar and the Zen stage.
 *
 * `next` is `playback.next()` rather than anything about rows: the order was
 * captured when playback started and this control does not need to know what it
 * was. The time sits `order-first` so it reads above the buttons whatever
 * container the parent drops this into.
 */
const playback = usePlaybackStore()

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
</script>

<template>
  <section class="flex flex-col items-center justify-center gap-0.5">
    <div class="flex items-center gap-1">
      <UButton
        icon="i-tabler-player-skip-back-filled"
        color="neutral"
        variant="ghost"
        :disabled="!playback.hasTrack"
        aria-label="Previous track"
        size="sm"
        @click="playback.previous()"
      />
      <UButton
        variant="ghost"
        :icon="playback.isPlaying ? 'i-tabler-player-pause-filled' : 'i-tabler-player-play-filled'"
        :color="playback.hasTrack ? 'primary' : 'neutral'"
        :loading="playback.isLoading"
        :disabled="!playback.hasTrack"
        size="xl"
        :aria-label="playback.isPlaying ? 'Pause' : 'Play'"
        :ui="{ leadingIcon: 'size-8' }"
        @click="playback.toggle()"
      />
      <UButton
        icon="i-tabler-player-skip-forward-filled"
        color="neutral"
        variant="ghost"
        :disabled="!playback.hasTrack"
        size="sm"
        aria-label="Next track"
        @click="playback.next()"
      />
    </div>

    <div
      v-if="playback.hasTrack"
      class="order-first flex justify-between tabular-nums text-xs font-medium text-muted"
    >
      <span>{{ formatTime(playback.currentTime) }}</span>
      <span>&nbsp;/&nbsp;</span>
      <span>{{ formatTime(playback.duration) }}</span>
    </div>
  </section>
</template>
