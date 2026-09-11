<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useLyricsStore } from '@renderer/stores/lyrics'
import { useElementSize } from '@renderer/shell/useElementSize'
import {
  createLyricsCursor,
  createRafClock,
  estimateTimeMs,
  scrollFraction,
  type LyricsCursor
} from './lyricsSync'

/**
 * The lyrics pane — the visible half of the stream (W17-3). A panel island under
 * `panels/` (D4) so the Tunedeck can host it later; StageView is only its first
 * host, the way `UDrawer` was the Tunedeck's. It reaches for the playback and
 * lyrics stores and nothing of its neighbours.
 *
 * It renders the six states a lyrics pane has to distinguish — synced, plain,
 * instrumental, not-found, loading, and "the operator is scrolling" — because
 * collapsing any of them into another is what makes a lyrics pane read as
 * broken. Timing lives in `lyricsSync.ts`; this file is DOM, state and the rAF
 * lifecycle.
 */
const playback = usePlaybackStore()
const lyrics = useLyricsStore()

/* ------------------------------------------------------------------ fetch --- */

// The track is the transport's; the store guards against a slow fetch for a
// track already skipped past (its monotonic `issued`). Immediate so the pane is
// populated the moment it mounts onto whatever is already playing.
watch(
  () => playback.nowPlaying?.id ?? null,
  (id) => {
    userScrolling.value = false
    void lyrics.load(id)
  },
  { immediate: true }
)

/* ------------------------------------------------------- deferred loading --- */

/**
 * The loading affordance is deferred so it never flashes on an ordinary skip: a
 * local sidecar or embedded read resolves in a few milliseconds, well under this
 * delay, so the pane swaps documents with no spinner at all. The affordance
 * appears only when a resolve genuinely takes a beat.
 */
const LOADING_AFFORDANCE_DELAY_MS = 220
const loadingVisible = ref(false)
let loadingTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => lyrics.loading,
  (busy) => {
    if (loadingTimer !== null) clearTimeout(loadingTimer)
    if (busy) {
      loadingTimer = setTimeout(() => {
        loadingVisible.value = true
      }, LOADING_AFFORDANCE_DELAY_MS)
    } else {
      loadingVisible.value = false
    }
  }
)

/* -------------------------------------------------------------- view state --- */

type LyricsState = 'loading' | 'error' | 'none' | 'instrumental' | 'plain' | 'synced' | 'blank'

const state = computed<LyricsState>(() => {
  const doc = lyrics.document
  if (doc) {
    if (doc.instrumental) return 'instrumental'
    if (doc.lines.length === 0) return 'none'
    return doc.synced ? 'synced' : 'plain'
  }
  if (lyrics.loading) return loadingVisible.value ? 'loading' : 'blank'
  if (lyrics.failed) return 'error'
  return 'none'
})

/** The line list the two text states render. */
const lines = computed(() => lyrics.document?.lines ?? [])

/** How the document was resolved, said quietly — it makes a wrong match diagnosable. */
const sourceLabel = computed(() => {
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

/* ---------------------------------------------------------------- timing --- */

const cursor = computed<LyricsCursor | null>(() => {
  const doc = lyrics.document
  if (!doc || !doc.synced) return null
  return createLyricsCursor(doc.lines, doc.offsetMs)
})

/**
 * The playhead in milliseconds. It advances in two regimes: the engine's coarse
 * `timeupdate` re-anchors it (below), and — while playing — the rAF clock
 * interpolates forward from that anchor for a smooth glide between the 250 ms
 * ticks. Which *line* is current is decided from this same value; a binary
 * search per frame is O(log n), which the card allows.
 */
const smoothMs = shallowRef(0)
let anchorSec = 0
let anchorAtMs = 0

function reanchor(): void {
  anchorSec = playback.currentTime
  anchorAtMs = performance.now()
}

// Every engine tick (and every seek, paused or not) re-anchors and, when the
// clock is not itself advancing time, sets the playhead directly — that is what
// makes a scrub land on the right line while paused.
watch(
  () => playback.currentTime,
  () => {
    reanchor()
    if (!clock.running) smoothMs.value = playback.currentTime * 1000
  }
)

const activePos = computed(() => cursor.value?.activePosAt(smoothMs.value) ?? -1)
const activeSrcIndex = computed(() => {
  const c = cursor.value
  const pos = activePos.value
  return c && pos >= 0 ? c.entries[pos]!.srcIndex : -1
})

/* --------------------------------------------------------------- scrolling --- */

const scrollerRef = ref<HTMLElement | null>(null)
const { height: scrollerHeight } = useElementSize(scrollerRef)

// Line elements by source index, for the centring maths. A plain array, not
// reactive: it is read inside the scroll write, not rendered.
let lineEls: (HTMLElement | null)[] = []
function registerLine(index: number, el: unknown): void {
  lineEls[index] = (el as HTMLElement | null) ?? null
}
// A new document is a new set of lines; drop the stale element handles so a
// shorter document cannot centre on an index that no longer exists.
watch(
  () => lyrics.document,
  () => {
    lineEls = []
  }
)

/** Half the viewport, so the spacers let the first and last lines reach centre. */
const spacerHeight = computed(() => `${Math.round(scrollerHeight.value / 2)}px`)

const reducedMotion =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
const prefersReducedMotion = ref(reducedMotion?.matches ?? false)
reducedMotion?.addEventListener('change', (e) => {
  prefersReducedMotion.value = e.matches
})

/**
 * Suspended while the operator scrolls by hand — autoscroll that fights the
 * reader is worse than none. A wheel, a touch drag or a navigation key is an
 * unambiguous manual intent; a programmatic `scrollTop` write fires none of
 * them, so there are no false positives to debounce away. Resumes on the
 * affordance, or on its own after a spell of no interaction.
 */
const userScrolling = ref(false)
const RESUME_AFTER_IDLE_MS = 5000
let resumeTimer: ReturnType<typeof setTimeout> | null = null
function onManualScroll(): void {
  userScrolling.value = true
  if (resumeTimer !== null) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    userScrolling.value = false
  }, RESUME_AFTER_IDLE_MS)
}
function jumpToCurrent(): void {
  if (resumeTimer !== null) clearTimeout(resumeTimer)
  userScrolling.value = false
  applyScroll()
}

// Only the keys that actually scroll the box count as a manual intent; Tabbing
// through or typing past a focused scroller must not suspend the autoscroll.
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar'
])
function onScrollKey(event: KeyboardEvent): void {
  if (SCROLL_KEYS.has(event.key)) onManualScroll()
}

function centerOf(srcIndex: number): number | null {
  const el = lineEls[srcIndex]
  if (!el) return null
  return el.offsetTop + el.offsetHeight / 2
}

/** Position the active line at the viewport centre, gliding toward the next. */
function applyScroll(): void {
  if (userScrolling.value) return
  const scroller = scrollerRef.value
  const c = cursor.value
  if (!scroller || !c) return

  const pos = c.activePosAt(smoothMs.value)
  let center: number | null
  if (pos < 0) {
    center = c.entries.length > 0 ? centerOf(c.entries[0]!.srcIndex) : null
  } else {
    const cur = c.entries[pos]!
    const curCenter = centerOf(cur.srcIndex)
    const next = c.entries[pos + 1]
    if (next && curCenter !== null) {
      const nextCenter = centerOf(next.srcIndex)
      if (nextCenter !== null) {
        const f = scrollFraction(cur.effMs, next.effMs, smoothMs.value)
        center = curCenter + (nextCenter - curCenter) * f
      } else center = curCenter
    } else center = curCenter
  }
  if (center === null) return
  const target = Math.max(0, center - scroller.clientHeight / 2)
  scroller.scrollTop = target
}

/* ----------------------------------------------------------- the rAF clock --- */

const clock = createRafClock(() => {
  smoothMs.value = estimateTimeMs(anchorSec, anchorAtMs, playback.isPlaying, performance.now())
  applyScroll()
})

// The loop earns its keep only while there is motion to interpolate and someone
// to see it: a synced document, playing, the pane not covered by a hidden
// window, and the reader not driving the scroll themselves. Reduced-motion
// opts out of interpolation entirely — the active line still moves, it just
// jumps rather than glides.
const docVisible = ref(
  typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
)
function onVisibility(): void {
  docVisible.value = document.visibilityState === 'visible'
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibility)
}

const animating = computed(
  () =>
    state.value === 'synced' &&
    playback.isPlaying &&
    docVisible.value &&
    !prefersReducedMotion.value &&
    !userScrolling.value
)

watch(animating, (on) => {
  if (on) {
    reanchor()
    clock.start()
  } else {
    clock.stop()
    // Settle exactly on the current line once the glide stops, so a pause or a
    // hide does not freeze the scroll a fraction of a line early.
    smoothMs.value = playback.currentTime * 1000
    applyScroll()
  }
})

// Snap to the active line whenever it changes outside the running clock — a
// paused seek, a reduced-motion session, or the first lines after a load.
watch([activeSrcIndex, scrollerHeight, () => lyrics.document], () => {
  if (!clock.running) applyScroll()
})

onBeforeUnmount(() => {
  clock.stop()
  if (loadingTimer !== null) clearTimeout(loadingTimer)
  if (resumeTimer !== null) clearTimeout(resumeTimer)
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility)
  }
})

function lineClass(index: number): string {
  if (state.value !== 'synced') return 'lyrics-line-plain'
  return index === activeSrcIndex.value ? 'lyrics-line-active' : 'lyrics-line-idle'
}
</script>

<template>
  <section class="lyrics-pane flex min-h-0 min-w-0 flex-col" aria-label="Lyrics">
    <!-- Synced or plain: the text itself. -->
    <div
      v-if="state === 'synced' || state === 'plain'"
      ref="scrollerRef"
      class="lyrics-scroller relative min-h-0 flex-1 overflow-y-auto"
      :class="state === 'synced' ? 'lyrics-scroller-synced' : ''"
      tabindex="0"
      @wheel="onManualScroll"
      @touchmove="onManualScroll"
      @keydown="onScrollKey"
    >
      <div :style="{ height: spacerHeight }" aria-hidden="true" />
      <p
        v-for="(line, index) in lines"
        :key="index"
        :ref="(el) => registerLine(index, el)"
        class="lyrics-line"
        :class="lineClass(index)"
      >
        {{ line.text || '\u00A0' }}
      </p>
      <div :style="{ height: spacerHeight }" aria-hidden="true" />
    </div>

    <!-- Everything else is a centred, quiet message — never an error shout. -->
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
      <template v-if="state === 'loading'">
        <UIcon name="i-tabler-loader-2" class="size-6 animate-spin text-dimmed" />
        <p class="text-sm text-dimmed">Looking for lyrics…</p>
      </template>
      <template v-else-if="state === 'instrumental'">
        <UIcon name="i-tabler-music" class="size-8 text-dimmed" />
        <p class="text-sm text-muted">Instrumental</p>
      </template>
      <template v-else-if="state === 'error'">
        <UIcon name="i-tabler-plug-connected-x" class="size-6 text-dimmed" />
        <p class="text-sm text-muted">Couldn’t load lyrics</p>
        <UButton size="xs" color="neutral" variant="subtle" @click="lyrics.refresh()">
          Try again
        </UButton>
      </template>
      <template v-else-if="state === 'none'">
        <UIcon name="i-tabler-microphone-2-off" class="size-8 text-dimmed" />
        <p class="text-sm text-dimmed">No lyrics for this track</p>
      </template>
      <!-- 'blank': a resolve too quick to be worth announcing. Deliberately empty. -->
    </div>

    <!-- Jump back to the current line — only while the reader has scrolled away. -->
    <Transition name="lyrics-jump">
      <div v-if="userScrolling && state === 'synced'" class="lyrics-jump">
        <UButton
          size="xs"
          color="neutral"
          variant="solid"
          icon="i-tabler-arrow-back-up"
          @click="jumpToCurrent"
        >
          Jump to current
        </UButton>
      </div>
    </Transition>

    <!-- Provenance, unobtrusive. W17-5's manual override hangs off this row. -->
    <p v-if="sourceLabel" class="lyrics-source shrink-0 text-xs text-dimmed">
      {{ sourceLabel }}
    </p>
  </section>
</template>

<style scoped>
.lyrics-pane {
  position: relative;
}

.lyrics-scroller {
  scrollbar-width: thin;
  /*
   * Fade the text into the pane's top and bottom edges so lines arrive and
   * leave rather than snapping at a hard boundary — the same feathering the
   * transport scrim uses, done in the mask so it costs no extra element.
   */
  mask-image: linear-gradient(to bottom, transparent 0, black 12%, black 88%, transparent 100%);
}

.lyrics-line {
  padding-block: 0.35rem;
  text-align: center;
  text-wrap: balance;
  transition:
    color 220ms ease,
    opacity 220ms ease,
    transform 220ms ease;
}

/* Plain document: readable body text, no highlight, no pretence of sync. */
.lyrics-line-plain {
  color: var(--ui-text-muted);
  font-size: 0.95rem;
  line-height: 1.5;
}

/* Synced idle lines sit back so the active one carries the eye. */
.lyrics-line-idle {
  color: var(--ui-text-dimmed);
  font-size: 1.05rem;
  opacity: 0.7;
}

.lyrics-line-active {
  color: var(--ui-text-highlighted);
  font-size: 1.2rem;
  font-weight: 600;
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-line {
    transition: none;
  }
}

.lyrics-jump {
  position: absolute;
  bottom: 2.25rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
}

.lyrics-jump-enter-active,
.lyrics-jump-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.lyrics-jump-enter-from,
.lyrics-jump-leave-to {
  opacity: 0;
  transform: translate(-50%, 0.5rem);
}

.lyrics-source {
  padding-top: 0.5rem;
  text-align: center;
}
</style>
