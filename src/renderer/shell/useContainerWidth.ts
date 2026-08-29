import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * A reactive width for one element, observed rather than read once.
 *
 * The repo already hand-rolls this pattern in a handful of panels (`FacetList`,
 * `ListeningChart`, `SettingsPane`) — a nulled `ResizeObserver`, observed on
 * mount, disconnected on unmount. This is the same shape in one place, for the
 * few frame regions whose *layout* has to change on their own width rather than
 * the viewport's: the transport folds its flanking controls into a popover when
 * Tunedeck squeezes it, and the frame reflows the side rail into a band above the
 * list when the sidebar and body can no longer sit side by side. CSS `@container`
 * covers everything that is only a restyle; this covers the cases that move DOM.
 *
 * Width, not size: every consumer branches on the inline axis, and observing one
 * number keeps the reads from re-running on a height-only change (a resized pane
 * split, a grown alert) that cannot cross a width breakpoint.
 *
 * The target is a template ref that is null until mount and again after unmount,
 * so the observer follows it rather than being wired once — a `v-if`'d container
 * that arrives late still gets measured.
 */
export function useContainerWidth(target: Ref<HTMLElement | null>): { width: Ref<number> } {
  const width = ref(0)

  let observer: ResizeObserver | null = null

  function measure(el: HTMLElement): void {
    width.value = el.clientWidth
  }

  watch(
    target,
    (el) => {
      observer?.disconnect()
      if (!el) {
        width.value = 0
        return
      }
      measure(el)
      observer = new ResizeObserver(() => measure(el))
      observer.observe(el)
    },
    { immediate: true, flush: 'post' }
  )

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return { width }
}

/**
 * The height twin of `useContainerWidth`, for the one frame region whose *layout*
 * turns on its own block size rather than its inline one: the sidebar drops its
 * full-size cover pane when the column is too short to hold both the cover and a
 * usable sources stack, the vertical counterpart of the §2 width band. Everything
 * else that reacts to height is a pane split, which CSS already handles — this is
 * only for the case that has to move DOM.
 *
 * A separate function rather than a `useContainerSize` returning both, for the
 * same reason the width one is width-only: observing one number keeps the reads
 * from re-running on a change to the axis the consumer does not care about.
 */
export function useContainerHeight(target: Ref<HTMLElement | null>): { height: Ref<number> } {
  const height = ref(0)

  let observer: ResizeObserver | null = null

  function measure(el: HTMLElement): void {
    height.value = el.clientHeight
  }

  watch(
    target,
    (el) => {
      observer?.disconnect()
      if (!el) {
        height.value = 0
        return
      }
      measure(el)
      observer = new ResizeObserver(() => measure(el))
      observer.observe(el)
    },
    { immediate: true, flush: 'post' }
  )

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return { height }
}
