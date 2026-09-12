/**
 * Applying a per-entity EQ assignment to the live curve, as a pure state machine
 * (W19-6).
 *
 * The architecture the equalizer already commits to is that there is one curve —
 * `audio.eq.active` — and the controller's watcher turns a write to it into
 * audio. An assignment therefore *writes that curve* when an assigned track
 * becomes current, rather than pushing a second spec down a parallel path. That
 * keeps the single push path (and the gapless/crossfade exclusivity that rides
 * it) intact, and it keeps the EQ pane honest: what it draws is what plays.
 *
 * Writing the curve means the operator's own curve has to be remembered, so that
 * leaving assigned content restores it rather than stranding the last album's
 * profile on everything after — the "haunted app" the card warns of. That
 * remembered curve is the **baseline**, and the three rules the card is exacting
 * about are the whole of this machine:
 *
 * - **A manual edit wins for the session.** A write to the curve that this
 *   machine did not make is the operator taking the wheel: it becomes the new
 *   baseline, and if an assignment was applied it is *suspended* — assignments
 *   stop fighting them until they resume.
 * - **Leaving assigned content restores the baseline**, not the last preset.
 * - **A disabled EQ, a suspension, or a dangling id all mean no assignment** —
 *   the baseline plays.
 *
 * Pure and Vue-free: the binding wires refs and IPC to it and mirrors its flags
 * into reactive state, so the rules test against plain values.
 */

import { sameSettingValue } from '@shared/settings'
import type { EqualizerSpec } from '@shared/audio/equalizer'
import type { EqAssignment } from './eqAssignment'

export interface EqApplierEffects {
  /** The live curve right now. */
  getActive: () => EqualizerSpec
  /** Write the live curve. The one path an assignment reaches the audio by. */
  setActive: (spec: EqualizerSpec) => void
}

export interface EqAssignmentApplier {
  /**
   * Bring the live curve into line with the resolved assignment for the current
   * track, under the master switch. Called at every track boundary and whenever
   * the assignment or the switch changes.
   */
  reconcile(assignment: EqAssignment, enabled: boolean): void
  /**
   * Note that the live curve changed. A change this machine did not make is a
   * manual edit: it re-baselines and suspends any applied assignment.
   */
  noticeActiveChange(active: EqualizerSpec): void
  /** Lift a suspension. The caller re-`reconcile`s to apply the current track's. */
  resume(): void
  /** Whether a manual edit has suspended assignments for the session. */
  readonly suspended: boolean
  /** The preset id an assignment currently holds in the curve, or null. */
  readonly appliedPresetId: string | null
}

export function createEqAssignmentApplier(effects: EqApplierEffects): EqAssignmentApplier {
  // The operator's own curve, restored when no assignment applies. Seeded from
  // whatever is live at construction — that is their curve until they change it.
  let baseline: EqualizerSpec = effects.getActive()
  let appliedPresetId: string | null = null
  let suspended = false
  // The exact spec this machine last wrote, so its own writes can be told from
  // the operator's in `noticeActiveChange` regardless of when the watch flushes.
  let lastWritten: EqualizerSpec | null = null

  function write(spec: EqualizerSpec, presetId: string | null): void {
    lastWritten = spec
    appliedPresetId = presetId
    effects.setActive(spec)
  }

  return {
    reconcile(assignment, enabled) {
      const applies = enabled && !suspended && assignment.spec !== null
      if (applies) {
        const active = effects.getActive()
        if (appliedPresetId !== assignment.presetId || !sameSettingValue(active, assignment.spec)) {
          write(assignment.spec as EqualizerSpec, assignment.presetId)
        }
      } else if (appliedPresetId !== null) {
        // Was showing an assignment; nothing applies now, so hand the curve back.
        write(baseline, null)
      }
    },
    noticeActiveChange(active) {
      // Our own write, echoing back through the settings watch — not a manual edit.
      if (lastWritten !== null && sameSettingValue(active, lastWritten)) return
      baseline = active
      lastWritten = active
      if (appliedPresetId !== null) {
        suspended = true
        appliedPresetId = null
      }
    },
    resume() {
      suspended = false
    },
    get suspended() {
      return suspended
    },
    get appliedPresetId() {
      return appliedPresetId
    }
  }
}
