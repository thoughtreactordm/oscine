<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useZenStore } from '@renderer/stores/zen'
import { useElementSize } from '@renderer/shell/useElementSize'
import { useStageTransport } from '@renderer/shell/useStageTransport'
import QuickMenu from '@renderer/panels/QuickMenu.vue'
import NowPlayingActions from '@renderer/panels/transport/NowPlayingActions.vue'
import PlaybackModeButtons from '@renderer/panels/transport/PlaybackModeButtons.vue'
import SeekBar from '@renderer/panels/transport/SeekBar.vue'
import TransportButtons from '@renderer/panels/transport/TransportButtons.vue'
import TransportOverflow from '@renderer/panels/transport/TransportOverflow.vue'
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

/**
 * The stage transport folds its flanking controls into the overflow popover when
 * it is too narrow to lay them out — the case the operator hits by opening
 * Tunedeck here, which narrows this stage without touching the window (§1). The
 * same `TransportOverflow` the bottom bar uses, measured off this transport's own
 * width rather than the viewport's. Only meaningful while the stage carries the
 * transport; the observer sits on the element, which only exists then.
 *
 * The number is higher than the bottom bar's 860 despite the lighter left flank,
 * because the verbs are centred between two equal `flex-1` sides and this row
 * carries far more side padding (`sm:px-8` against the bar's `px-3`). The wide
 * right cluster — volume and the standing modes — is mirrored across the centre,
 * so it reaches the verbs at a wider container than the bar does; below this it
 * would eclipse them. Tune by eye, not by theory.
 */
const stageTransportRef = ref<HTMLElement | null>(null)
const { width: transportWidth, height: transportHeight } = useElementSize(stageTransportRef)
const compactTransport = computed(() => transportWidth.value > 0 && transportWidth.value < 900)

/**
 * The bottom padding the content reserves so it centres in the space *above* the
 * floating transport instead of behind it. The transport is absolutely
 * positioned — it draws nothing into the flow — so without this the record and
 * caption centre against the whole stage and the bar sits statically on top of
 * them. It is the measured transport height, not a token, because the bar's
 * height is not fixed; a 7rem fallback covers the first frame before the observer
 * has reported. Only while the stage carries the transport; otherwise the bar is
 * a row of its own below the stage and there is nothing here to clear.
 */
const contentBottomReserve = computed(() =>
  stageOwnsTransport.value ? `${transportHeight.value || 112}px` : undefined
)

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
      class="relative flex h-full min-h-0 w-full flex-col p-4 sm:p-8"
      :style="{ paddingBottom: contentBottomReserve }"
    >
      <!--
        The record and its caption are one group, centred together in the space
        the stage leaves — so the title sits directly under the art instead of
        being shoved to the foot of the window when the art does not fill the
        height (the old layout gave the art `flex-1`, which ate the whole column
        and pushed the caption onto the transport). The art is capped at
        `--stage-art-max`; `max-h-full`/`max-w-full` keep it square while the box
        cap transfers through the ratio, so it can never spill past the caption
        into the transport scrim.
      -->
      <div
        class="stage-content flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-6"
      >
        <div
          class="stage-art aspect-square w-[var(--stage-art-max)] min-h-0 max-h-full max-w-full overflow-hidden rounded-xl border border-default bg-elevated shadow-2xl"
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

        <div
          v-if="playback.hasTrack"
          class="stage-caption flex min-w-0 max-w-2xl shrink-0 flex-col items-center gap-1 text-center"
        >
          <h2 class="truncate text-2xl font-bold tracking-tight text-highlighted">
            {{ playback.nowPlaying?.title }}
          </h2>
          <p v-if="byline" class="truncate text-base text-muted">{{ byline }}</p>
          <p v-if="playback.nowPlaying?.album" class="truncate text-sm text-dimmed">
            {{ playback.nowPlaying.album }}
          </p>
        </div>
        <p v-else class="shrink-0 text-sm text-dimmed">Nothing playing</p>
      </div>
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
      standing modes flank them. Absolutely positioned so it draws nothing into
      the content flow — the record above reserves its measured height as bottom
      padding (`contentBottomReserve`) and so centres in the space above it,
      rather than behind it.
    -->
    <div
      v-if="stageOwnsTransport"
      ref="stageTransportRef"
      class="stage-transport"
      aria-label="Now playing controls"
    >
      <SeekBar />
      <div class="flex items-center justify-between gap-6 px-4 py-4 sm:px-8">
        <!--
          An empty spacer holds the verbs centred once the actions fold away, so
          the collapse changes what is on the flanks, not where the verbs sit.
        -->
        <div v-if="compactTransport" class="min-w-0 flex-1" aria-hidden="true" />
        <NowPlayingActions v-else class="min-w-0 flex-1" />
        <TransportButtons class="shrink-0" />
        <div class="flex min-w-0 flex-1 items-center justify-end gap-3">
          <template v-if="!compactTransport">
            <VolumeControl />
            <PlaybackModeButtons />
          </template>
          <TransportOverflow v-else />
        </div>
      </div>
    </div>

    <!-- The Quick Menu, scoped to Now Playing (D26). When the stage carries the transport the bar that normally carries the drawer is not mounted, so the stage owns it. -->
    <QuickMenu v-if="stageOwnsTransport" />
  </section>
</template>

<style scoped>
/*
 * The cover's size cap. It grows with the window (`58vmin`) up to a hard 40rem
 * (~640px) ceiling and down to a 10rem floor, and never exceeds the height the
 * stage has spare — `100dvh` less a 26rem reserve for the title bar, tab row,
 * caption and transport. The reserve is deliberately generous so the height term
 * bites early: as the window shortens the record shrinks well ahead of the
 * caption reaching the transport, rather than staying `58vmin`-large until it
 * collides. `max-h-full`/`max-w-full` on the art keep it square while these caps
 * bite; this is only the ceiling the fit starts from. The same cap holds whether
 * or not the stage carries the transport.
 */
section {
  --stage-art-max: clamp(10rem, min(58vmin, calc(100dvh - 26rem)), 40rem);
}

/*
 * Low, wide windows — a 16:9 720p among them — don't have the height to stack the
 * caption under the record without it landing on the transport. Below a height
 * threshold the group turns on its side: the record on the left, the caption to
 * its right and left-justified, spending the width a short window has to spare
 * instead of the height it doesn't. Gated on a minimum width too, so a genuinely
 * small window keeps the stack rather than trying to wedge in a row.
 *
 * The row is also lifted off the transport: a short window leaves the centred
 * group sitting close to the bar below, so a bottom pad both reserves clearance
 * and shifts the vertical centre up, out of the transport's way.
 */
@media (max-height: 800px) and (min-width: 640px) {
  .stage-content {
    flex-direction: row;
    gap: 2rem;
    padding-bottom: 4rem;
  }

  .stage-art {
    flex-shrink: 0;
  }

  .stage-caption {
    align-items: flex-start;
    text-align: left;
  }
}

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
