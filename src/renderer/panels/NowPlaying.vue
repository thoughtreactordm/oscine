<script setup lang="ts">
import { computed } from 'vue'
import { hasArtwork } from '@shared/ipc'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'

/**
 * The transport island.
 *
 * Knows only the playback store — not the track list, not the library. That is
 * what lets it be docked anywhere later, and it is why "next track" is
 * `playback.next()` rather than anything about rows: the order was captured
 * when playback started and this panel does not need to know what it was.
 */
const playback = usePlaybackStore()

/**
 * The thumbnail toggles the sidebar's blow-up through the shell store rather
 * than an emit, because nothing between here and the sidebar is a parent of
 * both. This panel never learns whether anything is listening.
 */
const shell = useShellStore()

/**
 * The cover to bleed behind the bar, or null when there is nothing worth
 * blowing up. `large` rather than `small`: it is scaled well past its own size
 * either way, and the blur is what hides the upscale.
 */
const backdrop = computed(() => {
  const url = playback.nowPlaying?.artwork.large
  return url && hasArtwork(url) ? url : null
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
      thumb: 'opacity-0 cursor-pointer group-hover:opacity-100 w-2 h-2 z-20'
    }"
    @pointerdown="playback.beginScrub()"
    @update:model-value="onSeekInput"
    @change="playback.endScrub()"
    @pointerup="playback.endScrub()"
  />
  <UCard
    as="footer"
    variant="soft"
    class="relative isolate h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex w-full h-full items-center justify-between gap-6 overflow-hidden px-3' }"
    aria-label="Now playing"
  >
    <!--
      Keyed so a track change crossfades: Vue keeps the outgoing cover mounted
      while the incoming one arrives, and both are out of flow, so they overlap
      rather than shunting the controls.

      Two elements rather than one because the drift never ends. Vue decides what
      to wait for by taking the longest duration it can see, so an infinite
      animation on the transitioning element means it waits for an `animationend`
      that never arrives and the outgoing layer is never unmounted. The outer
      element owns the crossfade, the inner owns the drift, and neither has to
      know the other's timing.
    -->
    <Transition name="cover">
      <div v-if="backdrop" :key="backdrop" class="cover-bleed" aria-hidden="true">
        <div
          class="cover-bleed-art"
          :style="{
            backgroundImage: `url('${backdrop}')`,
            animationPlayState: playback.isPlaying ? 'running' : 'paused'
          }"
        />
      </div>
    </Transition>

    <section class="flex items-center gap-3">
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
          :icon="
            playback.isPlaying ? 'i-tabler-player-pause-filled' : 'i-tabler-player-play-filled'
          "
          :color="playback.hasTrack ? 'primary' : 'neutral'"
          :loading="playback.isLoading"
          :disabled="!playback.hasTrack"
          size="xl"
          :aria-label="playback.isPlaying ? 'Pause' : 'Play'"
          :ui="{
            leadingIcon: 'size-8'
          }"
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

      <div class="flex gap-3">
        <div class="flex justify-between tabular-nums text-xs font-medium text-muted">
          <span>{{ formatTime(playback.currentTime) }}</span
          >&nbsp;/&nbsp;
          <span>{{ formatTime(playback.duration) }}</span>
        </div>
      </div>
    </section>

    <Transition name="trackInfo" mode="out-in">
      <div v-if="playback.hasTrack" class="flex grow items-center justify-center">
        <!--
          The thumbnail is the control for the sidebar's blow-up, and it stands
          down once that blow-up is on screen — two copies of the same cover a
          few hundred pixels apart is one too many, and the sidebar pane carries
          its own dismiss.

          A real button rather than a click handler on the avatar: this has to be
          reachable by keyboard and announce its state, and the art inside it
          stays decorative because the button carries the label.

          Its trailing space lives on the inner element rather than on a `gap`
          between flex children. A gap belongs to the parent and would survive
          the collapse to the last frame, then vanish — a 12px jump exactly when
          the motion is meant to have settled.
        -->
        <Transition name="coverThumb">
          <div v-if="!shell.coverExpanded" class="cover-thumb">
            <div class="cover-thumb-inner pr-3">
              <UTooltip text="Show cover art">
                <button
                  type="button"
                  class="cover-toggle shrink-0 rounded-sm"
                  aria-label="Show cover art"
                  @click="shell.toggleCover()"
                >
                  <UAvatar
                    :src="playback.nowPlaying?.artwork.small"
                    :icon="playback.nowPlaying ? undefined : 'i-tabler-vinyl'"
                    alt=""
                    size="3xl"
                    class="rounded-sm"
                    :ui="{ image: 'size-full object-cover', icon: 'size-6 text-dimmed' }"
                    aria-hidden="true"
                  />
                  <span class="cover-toggle-hint" aria-hidden="true">
                    <UIcon name="i-tabler-arrows-diagonal" class="size-5 text-inverted" />
                  </span>
                </button>
              </UTooltip>
            </div>
          </div>
        </Transition>
        <!--
          Centred only while the thumbnail is gone. With the thumbnail present
          the block is read against its left edge, and ragged-left text beside a
          square would read as a misalignment rather than a choice.
        -->
        <div
          class="flex flex-col justify-center"
          :class="shell.coverExpanded ? 'items-center text-center' : ''"
        >
          <p class="truncate text-sm font-medium text-highlighted max-w-60">
            {{ playback.nowPlaying?.title ?? 'Nothing playing' }}
          </p>
          <p class="truncate text-xs text-muted">
            <span>{{ playback.nowPlaying?.album }}</span>
            <span v-if="playback.nowPlaying?.year"
              >&nbsp;&nbsp;•&nbsp;&nbsp;{{ playback.nowPlaying?.year }}</span
            >
          </p>
          <p class="truncate text-xs text-primary">{{ playback.nowPlaying?.albumArtist }}</p>
          <p v-if="playback.error" class="truncate text-xs text-error">{{ playback.error }}</p>
        </div>
        <div class="pl-3">
          <UTooltip text="Favorite?">
            <UButton variant="ghost" icon="i-tabler-heart" square />
          </UTooltip>
          <UTooltip text="Song Options">
            <UButton variant="ghost" icon="i-tabler-dots-vertical-filled" square />
          </UTooltip>
        </div>
      </div>
    </Transition>

    <div class="flex shrink-0 items-center gap-3">
      <section class="w-44 flex items-center gap-2">
        <UIcon name="i-tabler-volume" class="size-4 shrink-0 text-muted" />
        <USlider
          :model-value="playback.volume"
          class="min-w-0 flex-1"
          aria-label="Volume"
          :min="0"
          :max="1"
          :step="0.01"
          :ui="{
            thumb: 'opacity-0 cursor-pointer hover:opacity-100 w-3 h-3 -ml-0.5'
          }"
          @update:model-value="(value) => value !== undefined && playback.setVolume(value)"
        />
        <span class="wtext-right tabular-nums text-xs text-muted">
          {{ Math.round(playback.volume * 100) }}
        </span>
      </section>

      <UTooltip text="Open Tunedeck">
        <UButton variant="ghost" size="lg" icon="i-tabler-device-audio-tape" />
      </UTooltip>
    </div>
  </UCard>
</template>

<style scoped>
/*
 * Negative z-index rather than a z-index race with the controls: the card root
 * carries `isolate`, so this paints above the card's own surface and below
 * everything in flow without any sibling needing to opt in. `overflow-hidden`
 * there is what clips the overscaled, blurred edges.
 */
.cover-bleed {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: var(--fermata-cover-bleed);
}

.cover-bleed-art {
  position: absolute;
  inset: 0;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 100% 100%;
  filter: blur(var(--fermata-cover-blur)) saturate(3.6);
  /* The resting value for when the drift is off, set to the keyframes' midpoint
     so reduced motion gets the same framing as the average animated frame. */
  transform: scale(1.33);
  animation: cover-drift var(--fermata-cover-drift) ease-in-out infinite alternate;
  /* The blur is expensive to recompute; promoting the layer means the drift is
     a composited transform of a cached result, not a re-blur per frame. */
  will-change: transform;
}

/*
 * Deliberately tiny. Over 42s a 10% scale swing is below the threshold where
 * the eye reads it as animation — it reads as the bar being alive.
 */
@keyframes cover-drift {
  from {
    transform: scale(1.33) translate3d(-1.5%, -1%, 0);
  }
  to {
    transform: scale(1.66) translate3d(1.5%, 1%, 0);
  }
}

/*
 * The affordance only appears on hover or focus. A permanent overlay on the
 * thumbnail would compete with the art it is sitting on, and the art is the
 * reason anyone looks at that corner of the bar.
 */
.cover-toggle {
  position: relative;
  display: block;
  cursor: pointer;
  overflow: hidden;
}

.cover-toggle:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.cover-toggle-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklab, var(--ui-bg-inverted) 55%, transparent);
  opacity: 0;
  transition: opacity 150ms ease;
}

.cover-toggle:hover .cover-toggle-hint,
.cover-toggle:focus-visible .cover-toggle-hint {
  opacity: 1;
}

/*
 * The thumbnail wipes sideways rather than blinking out, so the track info
 * slides into the space instead of teleporting across it.
 *
 * `1fr` → `0fr` on a grid column rather than a width transition: the thumbnail
 * is sized by its own content, so there is no authored pixel width to animate
 * from, and hardcoding one here would be a second source of truth for the
 * avatar's size.
 */
.cover-thumb {
  display: grid;
  grid-template-columns: 1fr;
}

.cover-thumb-inner {
  min-width: 0;
}

/*
 * Clipping only while it moves. A permanent `overflow: hidden` would crop the
 * button's focus ring, which sits outside the box by design.
 */
.coverThumb-enter-active .cover-thumb-inner,
.coverThumb-leave-active .cover-thumb-inner {
  overflow: hidden;
}

.coverThumb-enter-active,
.coverThumb-leave-active {
  transition:
    grid-template-columns 260ms ease,
    opacity 260ms ease;
}

.coverThumb-enter-from,
.coverThumb-leave-to {
  grid-template-columns: 0fr;
  opacity: 0;
}

.cover-enter-active,
.cover-leave-active {
  transition: opacity 700ms ease;
}

.cover-enter-from,
.cover-leave-to {
  opacity: 0;
}

.trackInfo-enter-active,
.trackInfo-leave-active {
  transition:
    opacity 300ms ease,
    transform 300ms ease;
}

.trackInfo-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.trackInfo-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .cover-bleed-art {
    animation: none;
  }

  .cover-toggle-hint {
    transition-duration: 0ms;
  }

  .coverThumb-enter-active,
  .coverThumb-leave-active {
    transition-duration: 0ms;
  }

  .cover-enter-active,
  .cover-leave-active {
    transition-duration: 200ms;
  }

  .trackInfo-enter-active,
  .trackInfo-leave-active {
    transition-duration: 150ms;
  }

  .trackInfo-enter-from,
  .trackInfo-leave-to {
    transform: none;
  }
}
</style>
