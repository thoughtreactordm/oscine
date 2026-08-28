<script setup lang="ts">
import { computed } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useZenStore } from '@renderer/stores/zen'
import { useStageTransport } from '@renderer/shell/useStageTransport'
import QuickMenu from '@renderer/panels/QuickMenu.vue'
import NowPlayingActions from '@renderer/panels/transport/NowPlayingActions.vue'
import PlaybackModeButtons from '@renderer/panels/transport/PlaybackModeButtons.vue'
import SeekBar from '@renderer/panels/transport/SeekBar.vue'
import TransportButtons from '@renderer/panels/transport/TransportButtons.vue'
import VolumeControl from '@renderer/panels/transport/VolumeControl.vue'
import WaveformRibbon from '@renderer/panels/WaveformRibbon.vue'

/**
 * The Now Playing tab: one record, as large as the window allows.
 *
 * The only tab the frame draws without a sidebar. That is the whole point of it
 * — nothing to browse, nothing to choose, just what is playing — so it declares
 * `sidebar: false` in the route table and gets the full width.
 *
 * Transport normally stays where it always is, in the bar below — a second set of
 * controls here would be a second source of truth for the same three buttons. In
 * Zen mode there is no bar below: the frame has dropped it along with the title
 * bar and the tab row, so the stage carries the transport itself. It does so with
 * the *same* `panels/transport/*` components the bar composes, which is what
 * makes this a relocation rather than a second copy — the objection this comment
 * used to record no longer applies once the controls are shared.
 */
const playback = usePlaybackStore()
const zen = useZenStore()

/**
 * Whether this view is carrying the transport itself — in Zen, or when the
 * operator has merged the player into Now Playing. Both draw the same in-stage
 * controls; only Zen also hides the frame and offers an in-view way out.
 */
const stageOwnsTransport = useStageTransport()

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
    :class="{ 'stage-immersive': stageOwnsTransport }"
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

    <!--
      Exit affordance — the one always-reachable way out when Zen has hidden the
      title bar, the tab row and the transport. Fades in on approach so it does
      not sit over the art the mode exists to show; the palette, Ctrl/Cmd+Shift+Z
      and Esc are the others.
    -->
    <div v-if="zen.active" class="stage-exit">
      <UTooltip text="Exit Zen mode">
        <UButton
          icon="i-tabler-minimize"
          color="neutral"
          variant="ghost"
          aria-label="Exit Zen mode"
          @click="zen.exit()"
        />
      </UTooltip>
    </div>

    <div
      class="relative flex min-h-0 flex-col items-center gap-6 p-8"
      :class="{ 'pb-28': stageOwnsTransport }"
    >
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

    <!--
      The Zen transport. The bar the frame dropped, rebuilt from the same shared
      controls and laid out for a screen watched from across a room: the seek line
      spans the foot, the verbs sit centred over it, and the song actions and the
      standing modes flank them. Absolutely positioned so the record above stays
      centred in the window whether or not this is here.
    -->
    <div v-if="stageOwnsTransport" class="stage-transport" aria-label="Now playing controls">
      <SeekBar />
      <div class="flex items-center justify-between gap-6 px-8 py-4">
        <NowPlayingActions class="min-w-0 flex-1" />
        <TransportButtons class="shrink-0" />
        <div class="flex min-w-0 flex-1 items-center justify-end gap-3">
          <VolumeControl />
          <PlaybackModeButtons />
        </div>
      </div>
    </div>

    <!-- The Quick Menu, scoped to Now Playing (D26). When the stage carries the transport the bar that normally carries the drawer is not mounted, so the stage owns it. -->
    <QuickMenu v-if="stageOwnsTransport" />
  </section>
</template>

<style scoped>
/*
 * When the stage carries the transport — Zen, or the merged Now Playing view —
 * the waveform ribbon is dialled up. In its normal home the ribbon is faint
 * atmosphere rising from behind a footer in a row of its own; here the footer is
 * the floating transport over the foot of this stage, and left as-is the ribbon's
 * bright baseline sits directly under the transport's scrim and washes out. So it
 * is lifted clear of the transport — the centre line onto the bar's top edge, the
 * way the normal view reads — and brightened, with the blur eased back, for a
 * screen watched from across a room. The three custom properties are the ribbon's
 * own overrides; it stays ignorant of what layout put them there. The lift tracks
 * the transport's height, so a taller bar keeps the ribbon sitting on top of it.
 */
.stage-immersive {
  --waveform-ribbon-lift: 6.5rem;
  --waveform-ribbon-opacity: 0.5;
  --waveform-ribbon-blur: 14px;
}

/*
 * The Zen transport, pinned to the foot of the window. A scrim behind it lifts
 * the controls off whatever artwork is behind, top-feathered so it reads as the
 * bar dissolving into the stage rather than a hard edge across it.
 */
.stage-transport {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  z-index: 10;
  background: linear-gradient(
    to top,
    color-mix(in oklab, var(--ui-bg) 88%, transparent),
    transparent
  );
}

/*
 * The exit control only shows on approach — a chromeless mode with a button
 * always burning in the corner is not chromeless. Revealed by hovering the stage
 * or focusing the button, so the keyboard can reach it too.
 */
.stage-exit {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  z-index: 20;
  opacity: 0;
  transition: opacity 200ms ease;
}

section:hover .stage-exit,
.stage-exit:focus-within {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .stage-exit {
    transition-duration: 0ms;
  }
}

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
