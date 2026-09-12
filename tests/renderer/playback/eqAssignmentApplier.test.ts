import { describe, expect, it } from 'vitest'
import type { EqualizerSpec } from '../../../src/shared/audio/equalizer'
import { createEqAssignmentApplier } from '../../../src/renderer/playback/eqAssignmentApplier'
import type { EqAssignment } from '../../../src/renderer/playback/eqAssignment'

const spec = (preampDb: number): EqualizerSpec => ({ enabled: true, preampDb, bands: [] })

const assignment = (presetId: string | null, s: EqualizerSpec | null): EqAssignment => ({
  presetId,
  spec: s,
  dangling: presetId !== null && s === null
})

const NONE = assignment(null, null)

/** A harness that plays the settings watch: a write echoes back as a change. */
function harness(initial: EqualizerSpec) {
  let active = initial
  const applier = createEqAssignmentApplier({
    getActive: () => active,
    // The real setActive persists to a setting whose watch calls noticeActiveChange;
    // reproduce that echo so a test exercises the own-write discrimination.
    setActive: (next) => {
      active = next
      applier.noticeActiveChange(next)
    }
  })
  return {
    applier,
    get active() {
      return active
    },
    // A manual edit from the pane: writes the curve, then the watch fires.
    edit(next: EqualizerSpec) {
      active = next
      applier.noticeActiveChange(next)
    }
  }
}

describe('createEqAssignmentApplier', () => {
  const baseline = spec(0)
  const albumPreset = spec(-6)

  it('applies an assignment to the live curve at the boundary', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    expect(h.active).toEqual(albumPreset)
    expect(h.applier.appliedPresetId).toBe('album')
  })

  it('restores the baseline when the next track has no assignment', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    h.applier.reconcile(NONE, true)
    expect(h.active).toEqual(baseline)
    expect(h.applier.appliedPresetId).toBeNull()
  })

  it('does not suspend on its own writes', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    h.applier.reconcile(NONE, true)
    expect(h.applier.suspended).toBe(false)
  })

  it('a manual edit while an assignment plays suspends it for the session', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    // Operator drags a band — a curve this machine did not write.
    const edited = spec(3)
    h.edit(edited)
    expect(h.applier.suspended).toBe(true)
    expect(h.applier.appliedPresetId).toBeNull()
    // The next boundary does not override them.
    h.applier.reconcile(assignment('album', albumPreset), true)
    expect(h.active).toEqual(edited)
  })

  it('the manual edit becomes the new baseline restored on leaving assigned content', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    const edited = spec(3)
    h.edit(edited)
    h.applier.resume()
    // Resume re-applies the album preset for the current track...
    h.applier.reconcile(assignment('album', albumPreset), true)
    expect(h.active).toEqual(albumPreset)
    // ...and leaving restores the operator's edited curve, not the original.
    h.applier.reconcile(NONE, true)
    expect(h.active).toEqual(edited)
  })

  it('resume lets assignments apply again', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    h.edit(spec(3))
    expect(h.applier.suspended).toBe(true)
    h.applier.resume()
    expect(h.applier.suspended).toBe(false)
    h.applier.reconcile(assignment('album', albumPreset), true)
    expect(h.active).toEqual(albumPreset)
  })

  it('a disabled EQ applies no assignment', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), false)
    expect(h.active).toEqual(baseline)
    expect(h.applier.appliedPresetId).toBeNull()
  })

  it('a dangling assignment plays the baseline, not a stale curve', () => {
    const h = harness(baseline)
    h.applier.reconcile(assignment('album', albumPreset), true)
    // The preset is deleted: the id dangles (spec null) for the same album.
    h.applier.reconcile(assignment('album', null), true)
    expect(h.active).toEqual(baseline)
    expect(h.applier.appliedPresetId).toBeNull()
  })

  it('switches directly between two assigned presets at a boundary', () => {
    const h = harness(baseline)
    const other = spec(-3)
    h.applier.reconcile(assignment('album-a', albumPreset), true)
    h.applier.reconcile(assignment('album-b', other), true)
    expect(h.active).toEqual(other)
    expect(h.applier.appliedPresetId).toBe('album-b')
  })

  it('tracks a manual curve as the baseline even with no assignment in play', () => {
    const h = harness(baseline)
    const manual = spec(5)
    h.edit(manual)
    expect(h.applier.suspended).toBe(false)
    // A later assignment, then leaving it, restores the manual curve.
    h.applier.reconcile(assignment('album', albumPreset), true)
    h.applier.reconcile(NONE, true)
    expect(h.active).toEqual(manual)
  })
})
