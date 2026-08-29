import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * A reactive width and height for one element, observed rather than read once.
 *
 * The size twin of [`useContainerWidth`](./useContainerWidth.ts): same nulled
 * `ResizeObserver` that follows a late-arriving template ref, but it surfaces
 * both axes for the few regions whose *layout maths* need the cross axis too.
 *
 * The stage transport is the case it exists for. It floats over the foot of the
 * Now Playing stage, absolutely positioned so it does not push the record around
 * as it mounts; the content above it then has to reserve exactly its height to
 * centre in the space left rather than behind the bar. That height is not a
 * constant worth hard-coding — it moves with the seek line, the control row's
 * padding and whatever a theme does to either — so it is measured, not guessed.
 *
 * Where a consumer only branches on width, reach for `useContainerWidth`: one
 * number does not re-run its reads on a height-only change. This one is for when
 * the height is the point.
 */
export function useElementSize(target: Ref<HTMLElement | null>): {
  width: Ref<number>
  height: Ref<number>
} {
  const width = ref(0)
  const height = ref(0)

  let observer: ResizeObserver | null = null

  function measure(el: HTMLElement): void {
    width.value = el.clientWidth
    height.value = el.clientHeight
  }

  watch(
    target,
    (el) => {
      observer?.disconnect()
      if (!el) {
        width.value = 0
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

  return { width, height }
}
