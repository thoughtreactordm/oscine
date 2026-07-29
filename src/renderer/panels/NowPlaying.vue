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

function onSeekInput(value: number | undefined): void {
  if (value === undefined) return
  // A drag has already announced itself with `pointerdown`, so the position is
  // held until release. Keyboard seeking produces no pointer events at all and
  // commits immediately — otherwise an arrow key would move the handle and
  // never reach the audio.
  if (playback.scrubbing) playback.scrubTo(value)
  else playback.seek(value)
}
</script>

<template>
  <UCard
    as="footer"
    variant="soft"
    class="h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex h-full min-h-0 items-center gap-3 overflow-hidden p-2 sm:p-2' }"
    aria-label="Now playing"
  >
    <UAvatar
      :src="playback.nowPlaying?.artwork.small"
      :icon="playback.nowPlaying ? undefined : 'i-lucide-disc-3'"
      alt=""
      size="3xl"
      class="shrink-0 rounded-sm"
      :ui="{ image: 'size-full object-cover', icon: 'size-6 text-dimmed' }"
      aria-hidden="true"
    />

    <div class="w-52 min-w-0 shrink-0">
      <p class="truncate text-sm font-medium text-highlighted">
        {{ playback.nowPlaying?.title ?? 'Nothing playing' }}
      </p>
      <p class="truncate text-xs text-muted">{{ subtitle }}</p>
      <p v-if="playback.error" class="truncate text-xs text-error">{{ playback.error }}</p>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <UButton
        icon="i-lucide-skip-back"
        size="sm"
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
        size="sm"
        color="neutral"
        variant="ghost"
        :disabled="!playback.hasTrack"
        aria-label="Next track"
        @click="playback.next()"
      />
    </div>

    <div class="min-w-24 flex-1 space-y-1">
      <USlider
        :model-value="playback.currentTime"
        aria-label="Seek"
        :min="0"
        :max="playback.duration || 1"
        :step="0.01"
        :disabled="!playback.canSeek"
        @pointerdown="playback.beginScrub()"
        @update:model-value="onSeekInput"
        @change="playback.endScrub()"
        @pointerup="playback.endScrub()"
      />
      <div class="flex justify-between tabular-nums text-xs text-muted">
        <span>{{ formatTime(playback.currentTime) }}</span>
        <span>{{ formatTime(playback.duration) }}</span>
      </div>
    </div>

    <div class="flex w-44 shrink-0 items-center gap-2">
      <UIcon name="i-lucide-volume-2" class="size-4 shrink-0 text-muted" />
      <USlider
        :model-value="playback.volume"
        class="min-w-0 flex-1"
        aria-label="Volume"
        :min="0"
        :max="1"
        :step="0.01"
        @update:model-value="(value) => value !== undefined && playback.setVolume(value)"
      />
      <span class="w-8 text-right tabular-nums text-xs text-muted">
        {{ Math.round(playback.volume * 100) }}
      </span>
    </div>
  </UCard>
</template>
