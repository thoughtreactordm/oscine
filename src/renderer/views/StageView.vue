<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useLyricsStore } from '@renderer/stores/lyrics'
import { useZenStore } from '@renderer/stores/zen'
import { useElementSize } from '@renderer/shell/useElementSize'
import { useStageTransport } from '@renderer/shell/useStageTransport'
import { useSettings } from '@renderer/settings'
import { currentTheme, onThemeChange } from '@renderer/theme'
import { useVisualizerStore } from '@renderer/stores/visualizer'
import { resolveEffect } from '@renderer/visualizer/gate'
import { availableEffects } from '@renderer/visualizer/registry'
import { DEFAULT_MOTION_SEC } from '@renderer/visualizer/stageTransition'
import { MOTION_DURATION_PROPERTY, parseCssDurationSec } from '@renderer/visualizer/wash'
import { NOW_PLAYING_LYRICS_KEY, VISUALIZER_EFFECT_KEY } from '@shared/settings'
import LyricsPane from '@renderer/panels/LyricsPane.vue'
import QuickMenu from '@renderer/panels/QuickMenu.vue'
import NowPlayingActions from '@renderer/panels/transport/NowPlayingActions.vue'
import PlaybackModeButtons from '@renderer/panels/transport/PlaybackModeButtons.vue'
import SeekBar from '@renderer/panels/transport/SeekBar.vue'
import TransportButtons from '@renderer/panels/transport/TransportButtons.vue'
import TransportOverflow from '@renderer/panels/transport/TransportOverflow.vue'
import VisualizerStage from '@renderer/panels/VisualizerStage.vue'
import {
  TRANSPORT_STAGE_COMPACT_BELOW,
  transportIsCompact
} from '@renderer/panels/transport/transportLayout'
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
const lyrics = useLyricsStore()
const zen = useZenStore()
const settings = useSettings()

/**
 * The lyrics pane, W17-3. It is a panel island; this stage is only its first
 * host. It rides beside the record when the operator has it on, there is a track
 * to caption, and the stage is wide enough to give the record and a column of
 * text room without cramping either — below that the stage stays just the
 * record. Visibility is a durable Interface setting the stage also toggles.
 */
const sectionRef = ref<HTMLElement | null>(null)
const { width: stageWidth } = useElementSize(sectionRef)
const LYRICS_MIN_STAGE_WIDTH = 720
const lyricsEnabled = computed(() => settings.get<boolean>(NOW_PLAYING_LYRICS_KEY))
const showLyrics = computed(
  () => lyricsEnabled.value && playback.hasTrack && stageWidth.value >= LYRICS_MIN_STAGE_WIDTH
)
/** The stage affordance: the one place to bring lyrics back once they are off. */
const showLyricsToggle = computed(
  () => playback.hasTrack && stageWidth.value >= LYRICS_MIN_STAGE_WIDTH
)
function toggleLyrics(): void {
  void settings.set<boolean>(NOW_PLAYING_LYRICS_KEY, !lyricsEnabled.value)
}

/**
 * The stage visualizer, W23 (D35.4, D35.5, D35.7). Wanted is the stage toggle
 * with Zen's override applied (`visualizer/gate.ts`): with
 * `interface.visualizerInZen` on Zen shows it regardless, and a toggle pressed
 * inside Zen is a session override on the Zen store — Zen never writes
 * `interface.nowPlayingVisualizer`. The verbs live on the visualizer store, so
 * this button, the shortcuts and the palette share them (W23-6). It shows only with a track, under the same
 * width gate as lyrics, and never under reduced motion: a static visualizer is
 * just a background image, and the wash already is one. The toggle stays visible
 * then, disabled, and says why.
 */
const visualizer = useVisualizerStore()
const visualizerOn = computed(() => visualizer.wanted)

const reducedMotion = ref(false)
let motionQuery: MediaQueryList | null = null
function onMotionChange(event: MediaQueryListEvent): void {
  reducedMotion.value = event.matches
}

/** High Contrast makes the scrim opaque: legibility there is not negotiable. */
const highContrast = ref(currentTheme().themeId === 'high-contrast')
let releaseTheme: (() => void) | null = null

onMounted(() => {
  // Anything decided before this frame is painted starts in place, unanimated.
  requestAnimationFrame(() => {
    painted = true
  })
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = motionQuery.matches
  motionQuery.addEventListener('change', onMotionChange)
  releaseTheme = onThemeChange((state) => {
    highContrast.value = state.themeId === 'high-contrast'
  })
})
onBeforeUnmount(() => {
  layoutGeneration++
  layoutFade?.cancel()
  layoutFade = null
  motionQuery?.removeEventListener('change', onMotionChange)
  motionQuery = null
  releaseTheme?.()
  releaseTheme = null
})

/** Same gate as the lyrics toggle: a track, and room. */
const showVisualizerToggle = showLyricsToggle
const showVisualizer = computed(
  () => visualizerOn.value && !reducedMotion.value && showVisualizerToggle.value
)
const visualizerLabel = computed(() => {
  if (reducedMotion.value) return 'Visualizer is off while the system asks for reduced motion'
  return visualizerOn.value ? 'Hide visualizer' : 'Show visualizer'
})
function toggleVisualizer(): void {
  visualizer.toggle()
}

/**
 * The stage's presence for the shortcuts (W23-6, D35.5): they act only here, and
 * only when the control they stand for would — toggle when the button is
 * enabled, next/previous when the visualizer is on the stage to see it step.
 */
watch(
  () => ({
    canToggle: showVisualizerToggle.value && !reducedMotion.value,
    showing: showVisualizer.value
  }),
  (presence) => {
    visualizer.stage = presence
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  visualizer.stage = null
})

/**
 * `interface.visualizerCycle` (D35.5): a track change under a showing
 * visualizer advances the effect. Only while it is showing — a cycle nobody
 * sees would just churn the setting.
 */
watch(
  () => playback.nowPlaying?.id ?? null,
  (id, previous) => {
    if (id !== null && previous !== null && id !== previous && showVisualizer.value) {
      visualizer.cycle()
    }
  }
)

/**
 * The switch caption (D35.5): the effect's label, briefly, on the scrim, so
 * stepping through effects is navigable without opening anything. It follows
 * the *resolved* effect, so a stored id that resolves to the same effect shows
 * nothing, and it only fires while the visualizer is showing — turning it on is
 * not a switch.
 */
const SWITCH_CAPTION_MS = 1600
const shownEffect = computed(() =>
  resolveEffect(availableEffects(), settings.get<string>(VISUALIZER_EFFECT_KEY))
)
const switchCaption = ref<string | null>(null)
let switchCaptionTimer: ReturnType<typeof setTimeout> | null = null
watch(shownEffect, (next, previous) => {
  if (!next || next === previous || !showVisualizer.value) return
  switchCaption.value = next.label
  if (switchCaptionTimer !== null) clearTimeout(switchCaptionTimer)
  switchCaptionTimer = setTimeout(() => {
    switchCaption.value = null
    switchCaptionTimer = null
  }, SWITCH_CAPTION_MS)
})
watch(showVisualizer, (showing) => {
  if (!showing) switchCaption.value = null
})
onBeforeUnmount(() => {
  if (switchCaptionTimer !== null) clearTimeout(switchCaptionTimer)
  switchCaptionTimer = null
})

/**
 * Every transition passes through the wash (W23-5, D35.12). Wanted
 * (`showVisualizer`) is only the start of it; three pieces of state follow it:
 *
 * - `hostMounted` — the host stays mounted after it stops being wanted, while
 *   the effect settles back into the wash and hands it back, and unmounts only
 *   when it says it has retired. The ribbon fades back in then.
 * - `canvasOwnsWash` — mirrored from the host. True fades the `<img>` out
 *   (opacity only, one motion duration, linear) while the host's canvas fades
 *   the identical wash in at the matching rate; false is the reverse.
 * - `layoutOn` — the visualizer layout (cluster in the corner, panels on their
 *   scrims). It changes by a plain fade-through of the stage body: out, switch
 *   while nothing shows, back in — one motion duration each way. Nothing moves
 *   across the stage. Before the first paint it simply starts in place.
 *
 * Reduced motion skips all of it: the visualizer is off there (D35.7), at once.
 */
const bodyRef = ref<HTMLElement | null>(null)
const hostMounted = ref(false)
const canvasOwnsWash = ref(false)
const layoutOn = ref(false)
let painted = false
let layoutGeneration = 0
let layoutFade: Animation | null = null

function motionMs(): number {
  const section = sectionRef.value
  const motion = section
    ? parseCssDurationSec(getComputedStyle(section).getPropertyValue(MOTION_DURATION_PROPERTY))
    : null
  return (motion ?? DEFAULT_MOTION_SEC) * 1000
}

function fadeBodyIn(body: HTMLElement, from: number, ms: number): void {
  layoutFade = body.animate([{ opacity: from }, { opacity: 1 }], {
    duration: ms * (1 - from),
    easing: 'ease-out'
  })
}

/**
 * Fade the body out, switch the layout while it is invisible, fade it back in.
 * A change mid-fade picks up from the opacity on screen; turning back before
 * the switch just fades back in.
 */
async function changeLayout(next: boolean): Promise<void> {
  const generation = ++layoutGeneration
  const body = bodyRef.value
  const ms = motionMs()
  if (!body || !painted || reducedMotion.value || ms <= 0) {
    layoutFade?.cancel()
    layoutFade = null
    layoutOn.value = next
    return
  }
  const shown = Number.parseFloat(getComputedStyle(body).opacity)
  const from = Number.isFinite(shown) ? shown : 1
  layoutFade?.cancel()
  if (layoutOn.value === next) {
    fadeBodyIn(body, from, ms)
    return
  }
  const out = body.animate([{ opacity: from }, { opacity: 0 }], {
    duration: ms * from,
    easing: 'ease-in',
    fill: 'forwards'
  })
  layoutFade = out
  try {
    await out.finished
  } catch {
    return // cancelled by a newer change, which owns the body now
  }
  if (generation !== layoutGeneration) return
  layoutOn.value = next
  await nextTick()
  if (generation !== layoutGeneration) return
  fadeBodyIn(body, 0, ms)
  out.cancel()
}

watch(
  showVisualizer,
  (on) => {
    if (on) hostMounted.value = true
    void changeLayout(on)
  },
  { immediate: true }
)

watch(reducedMotion, (reduced) => {
  if (!reduced) return
  hostMounted.value = false
  canvasOwnsWash.value = false
})

function onHostWash(hidden: boolean): void {
  canvasOwnsWash.value = hidden
}

function onHostRetired(): void {
  if (showVisualizer.value) return
  hostMounted.value = false
  canvasOwnsWash.value = false
}

/**
 * How the shown document was resolved, said quietly and inline with the toggle
 * rather than floating at the foot of the pane. The pane is an island; the stage
 * owns the show/hide control, so the provenance that reads as a caption on it
 * belongs here beside it. Null unless lyrics are actually on screen with a known
 * source, so the toggle stands alone when there is nothing to attribute.
 */
const lyricsSource = computed(() => {
  if (!showLyrics.value) return null
  switch (lyrics.document?.source) {
    case 'sidecar':
      return 'from .lrc sidecar'
    case 'embedded':
      return 'from file tags'
    case 'lrclib':
      return 'from LRCLIB'
    default:
      return null
  }
})

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
 * The number is higher than the bottom bar's despite the lighter left flank,
 * because the verbs are centred between two equal `flex-1` sides and this row
 * carries far more side padding (`sm:px-8` against the bar's `px-3`). The wide
 * right cluster — volume and the standing modes — is mirrored across the centre,
 * so it reaches the verbs at a wider container than the bar does; below this it
 * would eclipse them. Compact is the expanded-volume layout: see
 * `transportLayout.ts`.
 */
const stageTransportRef = ref<HTMLElement | null>(null)
const { width: transportWidth, height: transportHeight } = useElementSize(stageTransportRef)
const compactTransport = computed(() =>
  transportIsCompact(transportWidth.value, TRANSPORT_STAGE_COMPACT_BELOW)
)

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
    ref="sectionRef"
    class="relative flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-default"
    :class="{
      'stage-immersive': stageOwnsTransport,
      'stage-visualizer': layoutOn,
      'stage-scrim-opaque': highContrast
    }"
    aria-label="Now playing"
  >
    <!--
      The art again, blown out and blurred, as the backdrop. It is the one
      colour source on this screen that is allowed to come from outside the
      token layer, because it is not a colour — it is the artwork itself. Its
      blur, colorization and bleed are the same `nowPlaying.*` tokens the
      transport bar and the focused song-list headers use, so authoring them in
      the token editor moves this wash in lockstep with every other cover
      backdrop rather than leaving the largest one behind — see `.stage-wash-img`.
      While the visualizer has the stage its canvas draws this same wash, and
      this one is faded out under it (D35.12) — opacity only, never its filter.
    -->
    <Transition name="stage-wash">
      <img
        v-if="cover"
        :key="cover"
        :src="cover"
        alt=""
        aria-hidden="true"
        class="stage-wash-img pointer-events-none absolute inset-0 size-full object-cover"
        :class="{ 'stage-wash-handed-off': canvasOwnsWash }"
        draggable="false"
      />
    </Transition>

    <!--
      The visualizer, in the wash slot (D35.4): over the wash, behind the body,
      no z-index of its own. It draws the wash itself, takes it over from the
      `<img>` above and hands it back before it unmounts (D35.12).
    -->
    <VisualizerStage
      v-if="hostMounted"
      :active="showVisualizer"
      @wash="onHostWash"
      @retired="onHostRetired"
    />

    <!--
      The switch caption (D35.5): the new effect's label on a small scrim pill,
      fading out on its own. A status region, so stepping by keyboard is
      announced as well as seen.
    -->
    <div class="stage-switch-caption-slot" role="status" aria-live="polite">
      <Transition name="stage-switch-caption">
        <span v-if="switchCaption" :key="switchCaption" class="stage-switch-caption">
          {{ switchCaption }}
        </span>
      </Transition>
    </div>

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

    <!--
      Lyrics toggle — the stage affordance the card asks for, and the only way
      back once lyrics are off (the pane cannot toggle itself when it is not
      shown). Reveals on approach like the Zen exit rather than burning a control
      into the corner; shifts left of the exit when Zen is also offering one.
    -->
    <div
      v-if="showLyricsToggle"
      class="stage-lyrics-toggle"
      :class="{ 'stage-lyrics-toggle-shifted': zen.active }"
    >
      <span v-if="lyricsSource" class="text-xs text-dimmed">{{ lyricsSource }}</span>
      <!--
        The visualizer toggle rides in the same group, so it shares the reveal and
        the width gate. Disabled, not hidden, under reduced motion — the tooltip
        says why — so the control does not vanish and leave the operator guessing.
      -->
      <UTooltip v-if="showVisualizerToggle" :text="visualizerLabel">
        <!-- A disabled button takes no pointer events; the span keeps the tooltip reachable. -->
        <span class="inline-flex">
          <UButton
            :icon="visualizerOn && !reducedMotion ? 'i-tabler-chart-bar' : 'i-tabler-chart-bar-off'"
            color="neutral"
            variant="ghost"
            :disabled="reducedMotion"
            :aria-label="visualizerLabel"
            :aria-pressed="visualizerOn && !reducedMotion"
            @click="toggleVisualizer"
          />
        </span>
      </UTooltip>
      <UTooltip :text="lyricsEnabled ? 'Hide lyrics' : 'Show lyrics'">
        <UButton
          :icon="lyricsEnabled ? 'i-tabler-microphone-2' : 'i-tabler-microphone-2-off'"
          color="neutral"
          variant="ghost"
          :aria-label="lyricsEnabled ? 'Hide lyrics' : 'Show lyrics'"
          :aria-pressed="lyricsEnabled"
          @click="toggleLyrics"
        />
      </UTooltip>
    </div>

    <div
      ref="bodyRef"
      class="stage-body relative flex h-full min-h-0 w-full flex-col p-4 sm:p-8"
      :class="{ 'stage-has-lyrics': showLyrics }"
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

        <!--
          `w-full` is load-bearing. This column is `items-center`, so without a
          definite width each line sizes to its own max-content; `truncate` then
          has nothing to clamp against and a long title overflows equally both
          ways — clipped by the stage's `overflow-hidden`, not ellipsized. The
          title wraps to two lines before the clamp; album and byline stay one.
        -->
        <div
          v-if="playback.hasTrack"
          class="stage-caption flex min-w-0 w-full max-w-2xl shrink-0 flex-col items-center gap-1 text-center"
        >
          <h2
            class="line-clamp-2 min-w-0 w-full wrap-anywhere text-2xl font-bold tracking-tight text-highlighted"
            :title="playback.nowPlaying?.title"
          >
            {{ playback.nowPlaying?.title }}
          </h2>
          <p v-if="byline" class="min-w-0 w-full truncate text-base text-muted" :title="byline">
            {{ byline }}
          </p>
          <p
            v-if="playback.nowPlaying?.album"
            class="min-w-0 w-full truncate text-sm text-dimmed"
            :title="playback.nowPlaying.album"
          >
            {{ playback.nowPlaying.album }}
          </p>
        </div>
        <p v-else class="shrink-0 text-sm text-dimmed">Nothing playing</p>
      </div>

      <LyricsPane v-if="showLyrics" class="stage-lyrics" />
    </div>

    <!--
      Last child, so it stacks over the wash and the record without needing a
      z-index of its own. It only exists on this route: the loop is bounded by
      the component's lifetime, and leaving the tab is what stops it. Suppressed
      while the visualizer is mounted (D35.4) — two visualizers at the foot of
      one stage is noise — without touching `interface.nowPlayingWaveform`, so
      the operator's ribbon comes back once the visualizer has settled away. It
      fades rather than cutting; the wrapper is the stage's own box, so the
      ribbon positions against it exactly as it did against the section.
    -->
    <Transition name="stage-ribbon">
      <div v-if="!hostMounted" class="pointer-events-none absolute inset-0">
        <WaveformRibbon />
      </div>
    </Transition>

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
      <div
        class="flex items-center justify-between"
        :class="compactTransport ? 'gap-3 px-3 py-3' : 'gap-6 px-4 py-4 sm:px-8'"
      >
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
 * The wash's look, in one place (D35.12): `.stage-wash-img` draws with these and
 * the visualizer host reads them to draw the identical wash on its canvas, so a
 * token-editor change moves both together. They are registered (the unscoped
 * block at the end) so their computed values are a resolved length and numbers,
 * not the `calc(…)` text an unregistered property would hand the host.
 */
section {
  --stage-wash-blur: calc(var(--oscine-cover-blur) * 1.6);
  --stage-wash-saturate: 2.2;
  --stage-wash-opacity: calc(var(--oscine-cover-bleed) * 1.1);
  --stage-wash-scale: 1.25;
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
    /*
     * Beside the record the caption takes leftover width, not its title's
     * max-content — otherwise a long line shoves the group past the stage
     * the same way the stacked layout used to clip both sides.
     */
    flex: 1 1 0;
    min-width: 0;
    width: auto;
  }
}

/*
 * With lyrics on, the stage turns on its side: the record and its caption on the
 * left at the size the art cap allows, a column of lyrics taking the width that
 * remains on the right. This is the row the view was already halfway to — the
 * short-and-wide media query above puts the caption beside the art the same way
 * — extended to the whole body rather than a second responsive scheme. The
 * render gate (`showLyrics`, min stage width) means this only ever applies with
 * the room for it, so it needs no width query of its own.
 *
 * `justify-content: center` is what keeps the pair honest on a wide window: once
 * the lyrics column hits its `max-width` cap the leftover width would otherwise
 * pool on the right and leave the record shoved against the left edge — the pair
 * instead sits centred as a unit, with even gutters. The gap tightens on a narrow
 * stage so the two never trade a readable column for whitespace.
 */
.stage-has-lyrics {
  flex-direction: row;
  align-items: stretch;
  justify-content: center;
  gap: clamp(1.5rem, 3vw, 2.5rem);
}

/*
 * The record cluster gives up both its `flex-1` claim and its `w-full` on the
 * whole body so it sizes to the art cap and leaves the rest to the lyrics.
 * `width: auto` is load-bearing: `w-full` (width: 100%) otherwise becomes the
 * flex basis under `flex-basis: auto`, so the cluster claims the full row and the
 * lyrics column shrinks to zero width — a pane that renders but cannot be seen.
 *
 * The `max-width` is the fix for a narrow stage — the half-width window with
 * Tunedeck open. `--stage-art-max` is sized off the viewport (`58vmin`), so
 * without a cap the record refuses to give way and crushes the lyrics into a
 * wrapping mess. Capping the cluster at a share of the row lets the art's
 * `max-w-full` shrink it in step, so the two always split the width rather than
 * the lyrics taking whatever the record leaves.
 */
.stage-has-lyrics .stage-content {
  flex: 0 1 auto;
  width: auto;
  max-width: 45%;
}

.stage-lyrics {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  max-width: 44rem;
}

/*
 * Visualizer mode (D35.4). The effect takes the wash, so the record gives up the
 * centre: the cover cluster drops to a compact size in the upper-left corner,
 * with the caption beside it. Left, not right (settled 2026-10-31, amending
 * D35.4's upper-right): the record already sits on the left whenever lyrics are
 * on, so the corner keeps it on its own side of the stage and lyrics keep their
 * column on the right — the visualizer reshapes the stage without swapping it. Both sit on the scrim pair —
 * the legibility guarantee: text contrast is a property of the theme, never of
 * whatever the effect drew underneath. The text tokens are re-pointed at the
 * on-scrim colour for the panel's subtree, so the caption (and LyricsPane,
 * unchanged) keep their own classes and still read on the scrim. In the High
 * Contrast theme the panel is opaque (below).
 *
 * The switch is a fade-through of the stage body (W23-5, `changeLayout`): out,
 * switch while nothing shows, back in. Nothing moves across the stage, and no
 * layout property is ever animated.
 */
section {
  /*
   * The card sizes to its caption, up to this. Alone on the stage it may run
   * most of the width, stopping short of the top-right toggles; beside lyrics it
   * takes half and the lyrics column the rest (below).
   */
  --stage-cluster-width: min(90rem, calc(100% - 10rem));
}

.stage-visualizer .stage-content,
.stage-visualizer .stage-lyrics {
  border-radius: 0.875rem;
}

/*
 * The scrim is frosted glass, not a flat slab: a `::before` layer behind each
 * panel blurs whatever the effect drew under it, carries the scrim, and is
 * feathered out at the top and bottom so the panel dissolves into the stage the
 * way the transport scrim does, and softened at the sides to match, so no edge
 * reads as a hard cut beside the feathered ones. Only the layer is masked — the
 * art and the text on top stay crisp (LyricsPane already fades its own lines at its edges). The
 * blur follows the cover-blur token so it moves with the rest of the cover
 * backdrops. `isolation` keeps the `z-index: -1` layer inside the panel.
 */
.stage-visualizer:not(.stage-scrim-opaque) .stage-content,
.stage-visualizer:not(.stage-scrim-opaque) .stage-lyrics {
  isolation: isolate;
  --stage-panel-feather: 2.5rem;
  --stage-panel-feather-x: 2rem;
  /* The card's right edge tapers longer and softer than its left; lyrics reset it below. */
  --stage-panel-feather-right: 9rem;
  --stage-panel-hint-right: 0.7;
  --ui-text: var(--oscine-on-scrim);
  --ui-text-toned: color-mix(in oklab, var(--oscine-on-scrim) 85%, transparent);
  --ui-text-highlighted: var(--oscine-on-scrim);
  --ui-text-muted: color-mix(in oklab, var(--oscine-on-scrim) 72%, transparent);
  --ui-text-dimmed: color-mix(in oklab, var(--oscine-on-scrim) 55%, transparent);
}

/* The cluster is already `absolute`; the lyrics column needs a box for the layer. */
.stage-visualizer:not(.stage-scrim-opaque) .stage-lyrics {
  position: relative;
  --stage-panel-feather: 7rem;
  --stage-panel-feather-x: 3rem;
  --stage-panel-feather-right: var(--stage-panel-feather-x);
  --stage-panel-hint-right: 0.6;
}

.stage-visualizer:not(.stage-scrim-opaque) .stage-content::before,
.stage-visualizer:not(.stage-scrim-opaque) .stage-lyrics::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  /*
   * Lighter than the bare scrim token: the blur under it does part of the work
   * of keeping the text off the effect, so the tint can let more colour through.
   */
  background: color-mix(in oklab, var(--oscine-scrim) 65%, transparent);
  backdrop-filter: blur(calc(var(--oscine-cover-blur) * 0.5));
  /*
   * Feathered on all four sides: the two ramps intersect, so the corners fall off
   * in both. The side ramps carry a colour hint that moves their midpoint in
   * towards the content, so the layer eases off early and then trails a long,
   * faint tail out to the rim rather than falling off in a straight line. The
   * further in the hint (`--stage-panel-hint-right`, as a share of the ramp from
   * the rim), the softer the edge.
   */
  mask-image:
    linear-gradient(
      to bottom,
      transparent 0,
      black var(--stage-panel-feather),
      black calc(100% - var(--stage-panel-feather)),
      transparent 100%
    ),
    linear-gradient(
      to right,
      transparent 0,
      calc(var(--stage-panel-feather-x) * 0.6),
      black var(--stage-panel-feather-x),
      black calc(100% - var(--stage-panel-feather-right)),
      calc(100% - var(--stage-panel-feather-right) * var(--stage-panel-hint-right)),
      transparent 100%
    );
  mask-composite: intersect;
}

/*
 * High Contrast: the panel is opaque — the theme's own elevated surface with its
 * own text tokens, whose pairs that theme is checked against strictly — so
 * nothing the effect draws can show through at all.
 */
.stage-scrim-opaque.stage-visualizer .stage-content,
.stage-scrim-opaque.stage-visualizer .stage-lyrics {
  background: var(--ui-bg-elevated);
  border: 1px solid var(--ui-border);
}

.stage-visualizer .stage-content {
  position: absolute;
  /* On the body's own padding line, so the cluster's top aligns with the lyrics column's. */
  top: 2rem;
  left: 2rem;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 2.5rem;
  border-radius: 1.75rem;
  width: auto;
  max-width: var(--stage-cluster-width);
  /*
   * Clear of the feathered edges, so the art and caption sit on the solid middle.
   * The right side runs long, so the caption breathes out into the longer taper.
   */
  padding: 2.5rem 12rem 2.5rem 3rem;
}

.stage-visualizer .stage-art {
  flex-shrink: 0;
  /*
   * 9rem on a roomy stage, shrinking with the window so a narrow one (the
   * 720px floor, Tunedeck open) still leaves the caption a readable width.
   */
  width: clamp(5rem, 11vw, 9rem);
  border-radius: 1rem;
  box-shadow: none;
}

.stage-visualizer .stage-caption {
  /*
   * Sized from its text, not from zero: the card is shrink-to-fit, so a zero
   * basis would let it settle narrower than the caption and truncate a title
   * that had room to show.
   */
  flex: 0 1 auto;
  min-width: 0;
  width: auto;
  align-items: flex-start;
  gap: 0;
  text-align: left;
}

.stage-visualizer .stage-caption h2 {
  font-size: 2rem;
  line-height: 1.2;
}

.stage-visualizer .stage-caption p {
  font-size: 1.625rem;
}

/*
 * Lyrics stay (settled 2026-10-31). With both on, the cluster is in the left
 * corner and the lyrics keep their column on the right — where they sit without
 * the visualizer — on a scrim panel of their own. The left padding reserves the
 * cluster's width so the two panels never overlap.
 */
.stage-visualizer .stage-has-lyrics {
  --stage-cluster-width: min(60rem, 50%);
  justify-content: flex-end;
  padding-left: calc(var(--stage-cluster-width) + 4rem);
}

.stage-visualizer .stage-lyrics {
  /* The sides clear the side feather so lines are never read through the fade. */
  padding: 1rem 3rem;
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

/*
 * The lyrics toggle sits in the same top-right approach zone as the Zen exit and
 * reveals the same way. When Zen is also drawing its exit there, this shifts a
 * button-width left so the two do not stack.
 */
.stage-lyrics-toggle {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  opacity: 0;
  transition: opacity 200ms ease;
}

.stage-lyrics-toggle-shifted {
  right: 3.25rem;
}

section:hover .stage-lyrics-toggle,
.stage-lyrics-toggle:focus-within {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .stage-exit,
  .stage-lyrics-toggle {
    transition-duration: 0ms;
  }
}

/*
 * The visualizer switch caption (W23-6, D35.5): top centre, clear of the
 * top-right controls, on a small frosted scrim pill. Never takes the pointer.
 */
.stage-switch-caption-slot {
  position: absolute;
  top: 0.75rem;
  inset-inline: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.stage-switch-caption {
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--oscine-on-scrim);
  background: color-mix(in oklab, var(--oscine-scrim) 65%, transparent);
  backdrop-filter: blur(calc(var(--oscine-cover-blur) * 0.5));
}

.stage-scrim-opaque .stage-switch-caption {
  color: var(--ui-text-highlighted);
  background: var(--ui-bg-elevated);
  backdrop-filter: none;
}

.stage-switch-caption-enter-active,
.stage-switch-caption-leave-active {
  transition: opacity calc(var(--oscine-motion-duration) * 2) ease;
}

.stage-switch-caption-enter-from,
.stage-switch-caption-leave-to {
  opacity: 0;
}

/*
 * The backdrop wash, driven by the same cover tokens as the transport bar
 * (`--oscine-cover-blur`, `--oscine-cover-bleed`) and colorized like the focused
 * song-list header (`FocusedBackdrop.vue`'s `saturate`). The multipliers hold
 * the resting look this used to hardcode — a `blur-3xl` (64px) off the 40px
 * default blur, and `opacity-20` off the ~0.18 default bleed, the same 1.1 the
 * focused header uses — while now tracking whatever the token editor sets. The
 * multipliers live in the `--stage-wash-*` properties on the section, which the
 * visualizer host reads too.
 *
 * The opacity transition is the handoff (D35.12): one motion duration, linear,
 * because the host fades its canvas wash in against exactly that ramp. Only the
 * opacity ever moves; the filter is never animated. A cover change still uses
 * the `stage-wash` transition below, whose rules come later and take over.
 */
.stage-wash-img {
  filter: blur(var(--stage-wash-blur)) saturate(var(--stage-wash-saturate));
  opacity: var(--stage-wash-opacity);
  transform: scale(var(--stage-wash-scale));
  transition: opacity var(--oscine-motion-duration) linear;
}

.stage-wash-handed-off {
  opacity: 0;
}

.stage-ribbon-enter-active,
.stage-ribbon-leave-active {
  transition: opacity calc(var(--oscine-motion-duration) * 2) ease;
}

.stage-ribbon-enter-from,
.stage-ribbon-leave-to {
  opacity: 0;
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

<style>
/*
 * Registered so their computed values resolve (W23-5, D35.12). Global by
 * nature — `@property` has no scope — and named for the stage alone.
 */
@property --stage-wash-blur {
  syntax: '<length>';
  inherits: true;
  initial-value: 0px;
}

@property --stage-wash-saturate {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}

@property --stage-wash-opacity {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}

@property --stage-wash-scale {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}
</style>
