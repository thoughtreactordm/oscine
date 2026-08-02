import { onScopeDispose, ref, watch, type Ref } from 'vue'

/**
 * Waiting long enough to be worth admitting to.
 *
 * ## Why a placeholder needs a delay at all
 *
 * A skeleton that appears for one frame is worse than no skeleton: the eye
 * reads a flash of grey bars as a glitch, not as progress. And most of the
 * deck's lookups are fast — an artist matched once is answered from two columns
 * of SQLite, so `identity.loading` is true for a couple of milliseconds on every
 * track change. Rendering a placeholder for those is how skipping through an
 * album turns into a strobe.
 *
 * So the flag only goes true once the wait has lasted long enough that
 * *something* has to be shown, and goes false the instant the wait ends. The
 * asymmetry is the whole design: slow to admit, quick to forget.
 *
 * ## Why it lives here rather than in the pane
 *
 * Timing is the part that is easy to get subtly wrong and impossible to see in
 * review — a timer that survives its scope, a stale timer that fires after the
 * source has already gone false and pins the placeholder on forever. Both are
 * one-line mistakes and both are testable, so they are tested.
 */

/**
 * How long a wait has to last before it is worth drawing.
 *
 * 150ms is the usual number for this and the reasoning is perceptual rather
 * than arbitrary: below about a tenth of a second a change reads as instant, so
 * a placeholder shown and removed inside that window is seen as a flicker with
 * no information in it. Above it, an unexplained frozen pane starts to read as
 * broken.
 *
 * It also happens to separate the deck's two kinds of lookup cleanly. A settled
 * artist is a database read and never reaches 150ms; an unsettled one is a
 * MusicBrainz search and always does. So the placeholder shows almost exactly
 * when the artist is one the deck has not seen before — which is also the only
 * time the biography underneath is about to change.
 */
export const LOADING_DELAY_MS = 150

/**
 * True once `source` has been continuously true for `delayMs`.
 *
 * Goes false immediately when `source` does, cancelling any pending timer —
 * without that, a wait that ends at 149ms would still raise the flag a
 * millisecond later and leave a placeholder over content that had already
 * arrived.
 */
export function useDeferredFlag(source: () => boolean, delayMs = LOADING_DELAY_MS): Ref<boolean> {
  const flag = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  watch(
    source,
    (waiting) => {
      clear()
      if (!waiting) {
        flag.value = false
        return
      }
      // The timer is restarted rather than left running, so a wait that ends
      // and begins again inside the window is two short waits rather than one
      // long one. That is what "continuously true" has to mean for the flag to
      // be worth anything.
      timer = setTimeout(() => {
        timer = null
        flag.value = true
      }, delayMs)
    },
    { immediate: true }
  )

  // The deck is long-lived but not immortal — a dock host that reparents it
  // unmounts this. A timer outliving its scope fires into a dead component.
  onScopeDispose(clear)

  return flag
}
