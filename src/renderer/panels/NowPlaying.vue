<script setup lang="ts">
import { computed } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The transport island.
 *
 * Knows only the playback store — not the track list, not the library. That is
 * what lets it be docked anywhere later, and it is why "next track" is
 * `playback.next()` rather than anything about rows: the order was captured
 * when playback started and this panel does not need to know what it was.
 */
const playback = usePlaybackStore()

/** Artist and album on one line, skipping whichever the file did not carry. */
const subtitle = computed(() => {
  const track = playback.nowPlaying
  if (!track) return 'Add a folder, then double-click a track'
  const parts = [track.artist, track.album].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' — ') : '—'
})

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function readValue(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}

function onSeekInput(event: Event): void {
  // A drag has already announced itself with `pointerdown`, so the position is
  // held until release. Keyboard seeking produces no pointer events at all and
  // commits immediately — otherwise an arrow key would move the handle and
  // never reach the audio.
  if (playback.scrubbing) playback.scrubTo(readValue(event))
  else playback.seek(readValue(event))
}
</script>

<template>
  <UCard>
    <div class="space-y-4">
      <UAlert
        v-if="playback.error"
        color="error"
        variant="subtle"
        icon="i-lucide-volume-x"
        :description="playback.error"
      />

      <div class="flex items-center gap-3">
        <div class="flex shrink-0 items-center gap-1">
          <UButton
            icon="i-lucide-skip-back"
            color="neutral"
            variant="ghost"
            :disabled="!playback.hasTrack"
            aria-label="Previous track"
            @click="playback.previous()"
          />
          <UButton
            :icon="playback.isPlaying ? 'i-lucide-pause' : 'i-lucide-play'"
            :color="playback.hasTrack ? 'primary' : 'neutral'"
            :loading="playback.isLoading"
            :disabled="!playback.hasTrack"
            :aria-label="playback.isPlaying ? 'Pause' : 'Play'"
            @click="playback.toggle()"
          />
          <UButton
            icon="i-lucide-skip-forward"
            color="neutral"
            variant="ghost"
            :disabled="!playback.hasTrack"
            aria-label="Next track"
            @click="playback.next()"
          />
        </div>

        <div class="min-w-0 flex-1">
          <p class="truncate text-sm text-highlighted">
            {{ playback.nowPlaying?.title ?? 'Nothing playing' }}
          </p>
          <p class="truncate text-xs text-muted">{{ subtitle }}</p>
        </div>

        <span class="shrink-0 tabular-nums text-xs text-muted">
          {{ formatTime(playback.currentTime) }} / {{ formatTime(playback.duration) }}
        </span>
      </div>

      <!-- Native range inputs: they give the pointer-down/release pair the seek
           arbitration needs, and keyboard access for free. The token layer
           reaches them through `accent-primary`, so a theme swap still costs no
           component change. -->
      <input
        type="range"
        class="w-full accent-primary"
        aria-label="Seek"
        min="0"
        :max="playback.duration || 1"
        step="0.01"
        :value="playback.currentTime"
        :disabled="!playback.canSeek"
        @pointerdown="playback.beginScrub()"
        @input="onSeekInput"
        @change="playback.endScrub()"
        @pointerup="playback.endScrub()"
      />

      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-volume-2" class="size-4 shrink-0 text-muted" />
        <input
          type="range"
          class="w-40 accent-primary"
          aria-label="Volume"
          min="0"
          max="1"
          step="0.01"
          :value="playback.volume"
          @input="playback.setVolume(readValue($event))"
        />
        <span class="tabular-nums text-xs text-muted">
          {{ Math.round(playback.volume * 100) }}%
        </span>
      </div>
    </div>
  </UCard>
</template>
