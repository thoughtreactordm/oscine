import { sameSettingValue } from '@shared/settings'
import type { EqualizerSpec } from '@shared/audio/equalizer'

/**
 * The equalizer editor's undo/redo stack (W19-10).
 *
 * Every editor gesture — a node drag, a band added or removed, a filter type
 * changed, a preamp move, a preset recalled — writes a whole new `EqualizerSpec`
 * to `audio.eq.active`. That single choke point is what makes undo cheap: a spec
 * is a small serialisable value, so history is a stack of specs, and undo is a
 * plain assignment back to `active`. Nothing here talks to the audio graph — the
 * settings watcher turns the assignment into sound, the same as any other edit.
 *
 * The one subtlety is coalescing a drag. A drag writes `active` on every rAF, but
 * the operator thinks of the whole drag as one action to undo. This module does
 * not watch those intermediate writes: the caller records only at gesture
 * boundaries (a drag records once on pointer-up, a discrete edit records itself),
 * so `baseline` lags the live curve during a drag and the single record captures
 * the pre-drag state. No pre-drag snapshot is needed — the lagging baseline *is*
 * it. See {@link createEqualizerState} for the wiring.
 *
 * Kept pure — nothing from `@renderer`, no Vue — the way `createClipLatch` is, so
 * a test drives it against literal specs without Pinia or a reactive scope.
 */

/** How many undo steps are kept. A gesture is one entry; a session rarely nears this. */
export const DEFAULT_HISTORY_LIMIT = 100

export interface SpecHistory {
  /** True when there is a prior state to return to. */
  readonly canUndo: boolean
  /** True when an undone state can be restored. */
  readonly canRedo: boolean
  /**
   * Note that `next` is now the live curve. If it differs from the baseline, the
   * old baseline becomes an undo step and the redo stack is dropped (a new edit
   * forks the timeline). A no-op when `next` equals the baseline — a drag that
   * landed where it started, or the echo of our own undo/redo write. Returns
   * whether an entry was pushed.
   */
  record(next: EqualizerSpec): boolean
  /** The state to write back, or null if there is nothing to undo. */
  undo(): EqualizerSpec | null
  /** The state to write back, or null if there is nothing to redo. */
  redo(): EqualizerSpec | null
  /** Adopt `baseline` as the current state and drop both stacks — a reload or reset. */
  reset(baseline: EqualizerSpec): void
}

export interface SpecHistoryOptions {
  limit?: number
}

export function createSpecHistory(
  initial: EqualizerSpec,
  options: SpecHistoryOptions = {}
): SpecHistory {
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT
  const past: EqualizerSpec[] = []
  const future: EqualizerSpec[] = []
  let baseline = initial

  return {
    get canUndo(): boolean {
      return past.length > 0
    },
    get canRedo(): boolean {
      return future.length > 0
    },
    record(next: EqualizerSpec): boolean {
      // Equal means either nothing moved or this is the settings echo of our own
      // undo/redo write — in both cases the timeline must not fork, so the redo
      // stack is left intact.
      if (sameSettingValue(next, baseline)) return false
      past.push(baseline)
      // Drop the oldest step rather than the newest: the deep past is the cheapest
      // thing to forget.
      if (past.length > limit) past.shift()
      baseline = next
      future.length = 0
      return true
    },
    undo(): EqualizerSpec | null {
      const prev = past.pop()
      if (prev === undefined) return null
      future.push(baseline)
      baseline = prev
      return baseline
    },
    redo(): EqualizerSpec | null {
      const next = future.pop()
      if (next === undefined) return null
      past.push(baseline)
      baseline = next
      return baseline
    },
    reset(next: EqualizerSpec): void {
      baseline = next
      past.length = 0
      future.length = 0
    }
  }
}
