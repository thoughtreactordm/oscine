<script setup lang="ts">
import { computed } from 'vue'
import MarqueeText from '@renderer/panels/MarqueeText.vue'
import QuickMenu from '@renderer/panels/QuickMenu.vue'
import NowPlayingActions from '@renderer/panels/transport/NowPlayingActions.vue'
import PlaybackModeButtons from '@renderer/panels/transport/PlaybackModeButtons.vue'
import SeekBar from '@renderer/panels/transport/SeekBar.vue'
import TransportButtons from '@renderer/panels/transport/TransportButtons.vue'
import VolumeControl from '@renderer/panels/transport/VolumeControl.vue'
import { hasArtwork } from '@shared/ipc'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'

/**
 * The transport island.
 *
 * Knows only the playback and shell stores — not the track list, not the
 * library. That is what lets it be docked anywhere later. Its controls are the
 * shared `panels/transport/*` set, the same ones the Zen stage composes, so the
 * two surfaces cannot drift: this bar arranges them, it does not own them. What
 * stays here is the chrome that is the bar's alone — the blurred cover bleed, the
 * cover-art thumbnail that toggles the sidebar blow-up, and the marquee'd track
 * line between the transport verbs.
 */
const playback = usePlaybackStore()

/**
 * The thumbnail toggles the sidebar's blow-up through the shell store rather than
 * an emit, because nothing between here and the sidebar is a parent of both. This
 * panel never learns whether anything is listening.
 */
const shell = useShellStore()

/**
 * The Quick Menu belongs to the Now Playing screen alone (D26). The transport is
 * always mounted, so without this its handle would follow the operator onto every
 * tab; gating on the active route keeps it scoped to where the drawer is. In Zen
 * mode the bar is not rendered at all, so the stage carries its own copy.
 */
const onNowPlayingScreen = computed(() => shell.activeTab === 'now-playing')

/**
 * The cover to bleed behind the bar, or null when there is nothing worth blowing
 * up. `large` rather than `small`: it is scaled well past its own size either
 * way, and the blur is what hides the upscale.
 */
const backdrop = computed(() => {
  const url = playback.nowPlaying?.artwork.large
  return url && hasArtwork(url) ? url : null
})
</script>

<template>
  <SeekBar />
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
      element owns the crossfade, the inner owns the drift.
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

    <!-- The transport verbs, centred. -->
    <TransportButtons class="order-2 shrink-0" />

    <!--
      The now-playing track — cover, title, favourite, options — is the panel's
      left column (`order-1`). It and the right cluster both take `flex-1`, so
      they reserve equal width and the transport between them reads as centred in
      the bar whatever is, or is not, playing.
    -->
    <Transition name="trackInfo" mode="out-in">
      <div v-if="playback.hasTrack" class="order-1 flex min-w-0 flex-1 items-center">
        <!--
          The thumbnail is the control for the sidebar's blow-up, and it stands
          down once that blow-up is on screen — two copies of the same cover a few
          hundred pixels apart is one too many, and the sidebar pane carries its
          own dismiss.
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
          Read against its left edge always, now the column is anchored there.
          When the thumbnail wipes away for the sidebar's blow-up the text holds
          its place rather than sliding to centre.
        -->
        <div class="flex min-w-48 max-w-72 flex-col justify-center">
          <MarqueeText
            class="text-sm font-medium text-highlighted"
            :text="playback.nowPlaying?.title ?? 'Nothing playing'"
          />
          <MarqueeText class="text-xs text-muted">
            <span>{{ playback.nowPlaying?.album }}</span>
            <span v-if="playback.nowPlaying?.year"
              >&nbsp;&nbsp;•&nbsp;&nbsp;{{ playback.nowPlaying?.year }}</span
            >
          </MarqueeText>
          <MarqueeText class="text-xs text-primary" :text="playback.nowPlaying?.albumArtist" />
          <p v-if="playback.error" class="truncate text-xs text-error">{{ playback.error }}</p>
        </div>
        <NowPlayingActions class="pl-3" />
      </div>
    </Transition>

    <div class="order-3 flex min-w-0 flex-1 items-center justify-end gap-3">
      <VolumeControl />
      <PlaybackModeButtons />
    </div>
  </UCard>

  <!--
    The Quick Menu — a left-edge drawer of favorite playlists, recent additions
    and favorite artists (D26). Rendered by the transport as the spec asks, but
    scoped to the Now Playing screen and drawn as a fixed pull-tab on the window's
    left edge rather than a control in this bar.
  -->
  <QuickMenu v-if="onNowPlayingScreen" />
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
  opacity: var(--oscine-cover-bleed);
}

.cover-bleed-art {
  position: absolute;
  inset: 0;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 100% 100%;
  filter: blur(var(--oscine-cover-blur)) saturate(3.6);
  /* The resting value for when the drift is off, set to the keyframes' midpoint
     so reduced motion gets the same framing as the average animated frame. */
  transform: scale(1.33);
  animation: cover-drift var(--oscine-cover-drift) ease-in-out infinite alternate;
  /* The blur is expensive to recompute; promoting the layer means the drift is
     a composited transform of a cached result, not a re-blur per frame. */
  will-change: transform;
}

/*
 * Deliberately tiny. Over 42s a 10% scale swing is below the threshold where the
 * eye reads it as animation — it reads as the bar being alive.
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
 * `1fr` → `0fr` on a grid column rather than a width transition: the thumbnail is
 * sized by its own content, so there is no authored pixel width to animate from.
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
