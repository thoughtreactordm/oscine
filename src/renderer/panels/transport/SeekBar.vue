<script setup lang="ts">
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The seek slider — the transport's one full-width control, lifted out of
 * `NowPlaying` so the bar and the Zen stage scrub the same track through the
 * same store rather than two copies of the same slider.
 *
 * Knows only the playback store, like every piece of the transport. A drag
 * announces itself with `pointerdown` and holds position until release; a
 * keyboard seek produces no pointer events and commits immediately — otherwise
 * an arrow key would move the handle and never reach the audio.
 */
const playback = usePlaybackStore()

function onSeekInput(value: number | undefined): void {
  if (value === undefined) return
  if (playback.scrubbing) playback.scrubTo(value)
  else playback.seek(value)
}
</script>

<template>
  <USlider
    :model-value="playback.currentTime"
    aria-label="Seek"
    size="xs"
    :min="0"
    :max="playback.duration || 1"
    :step="0.01"
    :disabled="!playback.canSeek"
    :ui="{
      root: 'group relative -mt-1 backdrop-blur-lg',
      track: 'rounded-none h-1',
      range: 'rounded-none h-1',
      thumb: 'opacity-0 cursor-pointer group-hover:opacity-100 w-2 h-2 z-20 transition-transform'
    }"
    @pointerdown="playback.beginScrub()"
    @update:model-value="onSeekInput"
    @change="playback.endScrub()"
    @pointerup="playback.endScrub()"
  />
</template>
