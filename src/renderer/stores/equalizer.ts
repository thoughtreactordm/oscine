import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useSettings } from '@renderer/settings'
import { usePlaybackStore } from '@renderer/stores/playback'
import { createClipLatch, createEqualizerState } from './equalizerState'

export {
  CLIP_THRESHOLD,
  DEFAULT_CLIP_HOLD_MS,
  createClipLatch,
  createEqualizerState,
  type ClipLatch,
  type EqualizerSettings,
  type EqualizerState,
  type EqualizerStateOptions
} from './equalizerState'

/**
 * The app's equalizer pane store, built over the shared settings surface.
 *
 * The preset/curve substance lives in `createEqualizerState` (`equalizerState.ts`),
 * which imports nothing from `@renderer` so it can be unit-tested without Pinia.
 * This wrapper binds it to the real settings store and adds the one thing that
 * cannot live there: the R11 clip monitor, whose poll reaches Web Audio through
 * the playback store and whose latch timing is the pure `createClipLatch` the
 * pane tests cover on its own.
 */
export const useEqualizerStore = defineStore('equalizer', () => {
  const state = createEqualizerState(useSettings())

  // The clip indicator (R11). Lit is reactive; the rest is the rAF poll lifecycle
  // the pane starts on mount and stops on unmount, so an analyser is attached only
  // while the pane is visible and a leaked frame cannot outlive it.
  const clipping = ref(false)
  const latch = createClipLatch()
  let tap: ReturnType<ReturnType<typeof usePlaybackStore>['subscribeEqualizerClip']> | null = null
  let frame: number | null = null

  function poll(): void {
    if (!tap) return
    latch.push(tap.peak(), performance.now())
    clipping.value = latch.lit
    frame = requestAnimationFrame(poll)
  }

  /** Begin watching the EQ output for clipping. Idempotent — a second call no-ops. */
  function startClipMonitor(): void {
    if (tap) return
    tap = usePlaybackStore().subscribeEqualizerClip()
    frame = requestAnimationFrame(poll)
  }

  /** Stop watching and release the tap — the analysers come down with the pane. */
  function stopClipMonitor(): void {
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    tap?.release()
    tap = null
    latch.clear()
    clipping.value = false
  }

  /** Acknowledge the indicator: clear it now rather than waiting out the latch. */
  function clearClip(): void {
    latch.clear()
    clipping.value = false
  }

  // W19-6: the per-entity assignment surface, owned by the always-on binding in
  // the playback store so assignments apply with the pane closed. Re-exposed here
  // so the EQ pane has one store to talk to for its list, its suspend banner and
  // its resume button.
  const assignment = usePlaybackStore().equalizerAssignment

  return {
    ...state,
    clipping,
    startClipMonitor,
    stopClipMonitor,
    clearClip,
    assignmentSuspended: assignment.suspended,
    assignments: assignment.assignments,
    refreshAssignments: assignment.refreshAssignments,
    resumeAssignments: assignment.resume,
    assign: assignment.assign
  }
})
