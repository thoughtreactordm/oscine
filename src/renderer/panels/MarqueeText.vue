<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * One line of text that crops to an ellipsis at rest and scrolls its full self
 * past on hover — but only when it is actually too long to fit. A title that
 * fits stays put; there is nothing to reveal and a marquee that ran anyway would
 * be motion for its own sake.
 *
 * "Too long" is measured, not guessed. `is-overflowing` is toggled from the real
 * `scrollWidth`/`clientWidth` gap, so the hover animation is armed only on the
 * lines that hide something. A `ResizeObserver` catches the column narrowing
 * under a pane drag; a `MutationObserver` catches the text changing when the
 * track does. Both feed the same `measure`.
 *
 * The hover itself is CSS — the animation lives behind `.is-overflowing:hover`,
 * so it survives re-renders and never needs a listener. Script only supplies the
 * distance and a duration scaled to it, so every title scrolls at one speed
 * whatever its length. `prefers-reduced-motion` holds it at the ellipsis.
 */
defineProps<{
  /**
   * The text to show. A prop rather than only a slot so the common case reads as
   * `<MarqueeText :text="title" />`; the default slot overrides it for lines that
   * carry markup of their own.
   */
  text?: string | null
}>()

const root = ref<HTMLElement | null>(null)
const inner = ref<HTMLElement | null>(null)

/** Pixels by which the text exceeds its container. Zero means it fits. */
const overflow = ref(0)

function measure(): void {
  const el = inner.value
  if (!el) return
  overflow.value = Math.max(0, el.scrollWidth - el.clientWidth)
}

/**
 * A duration proportional to the distance, so the scroll speed is a constant
 * rather than a function of how long the title is. The travel segments in the
 * keyframes are 35% of the timeline each; a floor keeps a barely-clipped line
 * from whipping past.
 */
const style = computed(() => {
  const distance = overflow.value
  const oneWay = Math.max(0.8, distance / 45)
  return {
    '--marquee-distance': `${distance}px`,
    '--marquee-duration': `${(oneWay / 0.35).toFixed(2)}s`
  }
})

let resize: ResizeObserver | null = null
let mutation: MutationObserver | null = null

onMounted(() => {
  measure()
  // The container narrows under a pane drag; its width is what the fit is
  // measured against.
  resize = new ResizeObserver(measure)
  if (root.value) resize.observe(root.value)
  // The clipped inner keeps the container's width, so its own box never changes
  // when the track does — the text swap has to be watched directly.
  mutation = new MutationObserver(measure)
  if (inner.value) {
    mutation.observe(inner.value, { childList: true, characterData: true, subtree: true })
  }
  // A late-loading font remeasures once its metrics are the real ones.
  void document.fonts?.ready.then(measure)
})

onBeforeUnmount(() => {
  resize?.disconnect()
  resize = null
  mutation?.disconnect()
  mutation = null
})
</script>

<template>
  <div ref="root" class="marquee">
    <div
      ref="inner"
      class="marquee__inner"
      :class="{ 'is-overflowing': overflow > 0 }"
      :style="style"
    >
      <slot>{{ text }}</slot>
    </div>
  </div>
</template>

<style scoped>
.marquee {
  display: block;
  overflow: hidden;
}

.marquee__inner {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/*
  On hover the inner grows to its natural width and slides; the outer clips it.
  Only armed once `is-overflowing` says there is something past the edge.
*/
.marquee__inner.is-overflowing:hover {
  width: max-content;
  overflow: visible;
  text-overflow: clip;
  animation: marquee-scroll var(--marquee-duration, 6s) linear infinite;
}

@keyframes marquee-scroll {
  0%,
  12% {
    transform: translateX(0);
  }
  47%,
  53% {
    transform: translateX(calc(-1 * var(--marquee-distance, 0px)));
  }
  88%,
  100% {
    transform: translateX(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .marquee__inner.is-overflowing:hover {
    width: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    animation: none;
  }
}
</style>
