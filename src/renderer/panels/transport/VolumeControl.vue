<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * The volume control — icon, a bar that wipes open on approach, and a readout —
 * lifted out of `NowPlaying` whole, its window listeners and geometry with it, so
 * the bar and the Zen stage set the same volume through one self-contained
 * island.
 *
 * Whether the bar is open — hover, keyboard focus, or a drag in progress. Hover
 * is read from the pointer's *geometry* against the control's box, not from
 * `:hover` or `pointerenter`/`pointerleave`. The slider takes pointer capture
 * while dragged, and Chromium leaves both `:hover` and the enter/leave tracking
 * stuck on the capture target after release — the bar latches open for as long as
 * the cursor is anywhere in the window, which is the bug this replaces. A window
 * `pointermove` reports true coordinates throughout a capture and after it, so
 * testing them against the section's rect is immune.
 *
 * Keyboard focus opens it too, but not the click that also focuses the thumb —
 * see `onVolumeFocusIn`. The drag flag holds it through a grab whose captured
 * pointer strays off the row.
 */
const playback = usePlaybackStore()

const volumeHovered = ref(false)
const volumeKeyboard = ref(false)
const volumeDragging = ref(false)
const volumeOpen = computed(
  () => volumeHovered.value || volumeKeyboard.value || volumeDragging.value
)
const volumeSection = ref<HTMLElement | null>(null)

/** Modality of the last interaction, to tell a Tab-focus from a click-focus. */
let volumeFocusFromKeyboard = false

function onWindowPointerMove(event: PointerEvent): void {
  const el = volumeSection.value
  if (!el) {
    volumeHovered.value = false
    return
  }
  const rect = el.getBoundingClientRect()
  volumeHovered.value =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
}

function onWindowKeydown(): void {
  volumeFocusFromKeyboard = true
}

function onWindowPointerdown(): void {
  volumeFocusFromKeyboard = false
}

onMounted(() => {
  window.addEventListener('pointermove', onWindowPointerMove)
  // Capture, so the modality is recorded before the focus these produce lands.
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('pointerdown', onWindowPointerdown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('pointerdown', onWindowPointerdown, true)
  window.removeEventListener('pointerup', endVolumeAdjust)
  window.removeEventListener('pointercancel', endVolumeAdjust)
})

function onVolumeFocusIn(): void {
  // Not `:focus-visible`: reka focuses the thumb from its own pointerdown, and
  // Chromium matches `:focus-visible` on that programmatic focus — so a mouse
  // click would key the bar open until the next click landed elsewhere. The
  // focus is "keyboard" only when the interaction that caused it was a key.
  volumeKeyboard.value = volumeFocusFromKeyboard
}

function beginVolumeAdjust(): void {
  volumeDragging.value = true
  window.addEventListener('pointerup', endVolumeAdjust)
  window.addEventListener('pointercancel', endVolumeAdjust)
}

function endVolumeAdjust(): void {
  volumeDragging.value = false
  window.removeEventListener('pointerup', endVolumeAdjust)
  window.removeEventListener('pointercancel', endVolumeAdjust)
}
</script>

<template>
  <!--
    The whole control's hover buffer: an even hit-area — taller top and bottom
    than it is wide — that opens the bar as the cursor arrives and holds it while
    the aim drifts toward the thumb. The negative margins cancel the padding in
    the margin box, so the row's spacing is untouched; only the hoverable area
    grows.
  -->
  <section
    ref="volumeSection"
    class="volume -mx-2 -my-3 flex items-center gap-1 px-2 py-3"
    :class="{ 'is-open': volumeOpen }"
    @focusin="onVolumeFocusIn"
    @focusout="volumeKeyboard = false"
  >
    <UIcon name="i-tabler-volume" class="size-5 shrink-0 text-muted" />
    <div class="volume-track">
      <USlider
        :model-value="playback.volume"
        class="w-24"
        aria-label="Volume"
        :min="0"
        :max="1"
        :step="0.01"
        :ui="{
          root: 'group px-2',
          track: 'h-1.5',
          range: 'h-1.5',
          thumb:
            'opacity-0 cursor-pointer group-hover:opacity-100 w-3 h-3 -ml-0.5 transition-opacity'
        }"
        @pointerdown="beginVolumeAdjust"
        @update:model-value="(value) => value !== undefined && playback.setVolume(value)"
      />
    </div>
    <span class="w-7 shrink-0 text-right tabular-nums text-xs text-muted">
      {{ Math.round(playback.volume * 100) }}
    </span>
  </section>
</template>

<style scoped>
/*
 * The volume slider keeps to itself until asked for. Collapsed it is width zero
 * and clipped; hover, keyboard focus, or an in-progress drag open it to the
 * slider's own width. Width — not opacity — carries the motion, so the icon and
 * readout slide together as it opens rather than the bar fading in over its
 * neighbours.
 */
.volume-track {
  width: 0;
  /*
   * Clip across, not down. The thumb stands taller and wider than the 1.5px
   * track it rides, so a plain `overflow: hidden` shaves it to a square as it
   * rides the ends and folds away. `clip` on one axis is what lets the other
   * stay `visible` — `hidden` would force it to `auto` — and the slider's own
   * `px-2` keeps the thumb clear of the horizontal clip at either extreme.
   */
  overflow-x: clip;
  overflow-y: visible;
  /*
   * The closing transition. A beat of delay so a cursor that clips the edge for
   * a moment doesn't fold the bar away, then a slightly slower ease-out as it
   * goes. Opening overrides both below to stay immediate — the reveal should
   * meet the cursor, and only the retreat is worth easing.
   */
  transition: width 260ms ease-out 250ms;
}

.volume.is-open .volume-track {
  width: 6rem;
  transition: width 150ms ease 0ms;
}

@media (prefers-reduced-motion: reduce) {
  .volume-track,
  .volume.is-open .volume-track {
    transition-duration: 0ms;
    transition-delay: 0ms;
  }
}
</style>
