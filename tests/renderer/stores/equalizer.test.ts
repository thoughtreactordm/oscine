import { describe, expect, it } from 'vitest'
import { computed, shallowRef, type WritableComputedRef } from 'vue'
import { AUDIO_EQ_ACTIVE, AUDIO_EQ_ENABLED, AUDIO_EQ_PRESETS } from '@shared/settings'
import type { EqualizerSpec } from '@shared/audio/equalizer'
import {
  CLIP_THRESHOLD,
  DEFAULT_CLIP_HOLD_MS,
  createClipLatch,
  createEqualizerState,
  type EqualizerSettings
} from '../../../src/renderer/stores/equalizerState'
import { settingsStoreFixture } from '../settings/fixture'

/**
 * A settings surface that records which keys are written, layered over the real
 * fixture so `value()` builds its writable computed against *this* set — that is
 * what lets the count catch an `active.value =` assignment, not only a direct
 * `set` call.
 */
function countingSettings(base: EqualizerSettings): {
  settings: EqualizerSettings
  writes: string[]
} {
  const writes: string[] = []
  const settings: EqualizerSettings = {
    get: <T>(key: string): T => base.get<T>(key),
    set: <T>(key: string, next: T): unknown => {
      writes.push(key)
      return base.set<T>(key, next)
    },
    value: <T>(key: string): WritableComputedRef<T> =>
      computed<T>({
        get: () => settings.get<T>(key),
        set: (next: T) => {
          settings.set<T>(key, next)
        }
      })
  }
  return { settings, writes }
}

function sequentialIds(): () => string {
  let n = 0
  return () => `id-${++n}`
}

function state(settings: EqualizerSettings, newId = sequentialIds()) {
  return createEqualizerState(settings, { newId })
}

const bassBoost: EqualizerSpec = {
  enabled: true,
  preampDb: -2,
  bands: [{ id: 'b1', type: 'lowshelf', frequencyHz: 120, gainDb: 6, q: 0.7, enabled: true }]
}

/** One band at a given frequency — a drag moving a handle along the axis. */
function bandsAt(frequencyHz: number): EqualizerSpec['bands'] {
  return [{ id: 'b1', type: 'peaking', frequencyHz, gainDb: 3, q: 1, enabled: true }]
}

/** A distinct curve, so a test can tell the override apart from the global. */
const trebleLift: EqualizerSpec = {
  enabled: true,
  preampDb: 0,
  bands: [{ id: 't1', type: 'highshelf', frequencyHz: 8000, gainDb: 4, q: 0.7, enabled: true }]
}

describe('createEqualizerState', () => {
  it('saves the live curve as a named preset and returns its id', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost

    const id = eq.savePreset('Bass boost')

    expect(id).toBe('id-1')
    expect(eq.presets.value).toEqual([{ id: 'id-1', name: 'Bass boost', spec: bassBoost }])
  })

  it('preserves preset ids across a reload of the state', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost
    const id = eq.savePreset('Bass boost')

    // A fresh state over the same stored settings is what a window reopen is.
    const reloaded = state(store.settings)
    expect(reloaded.presets.value.map((p) => p.id)).toEqual([id])
    expect(reloaded.presets.value[0]?.spec).toEqual(bassBoost)
  })

  it('recovers the applied preset on reload when the active curve matches one', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost
    const id = eq.savePreset('Bass boost')

    // A fresh state over the same stored settings — a window reopen. The persisted
    // active curve is still `bassBoost`, so the selector should point at its preset
    // rather than opening blank.
    const reloaded = state(store.settings)
    expect(reloaded.appliedPresetId.value).toBe(id)
    expect(reloaded.dirty.value).toBe(false)
  })

  it('opens with no applied preset on reload when the active curve matches none', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.savePreset('Bass boost')
    // The live curve is hand-edited off the preset before the reload.
    eq.active.value = { enabled: true, preampDb: 0, bands: [] }

    const reloaded = state(store.settings)
    expect(reloaded.appliedPresetId.value).toBeNull()
  })

  it('recalls a preset by writing audio.eq.active', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost
    const id = eq.savePreset('Bass boost')
    // Move the live curve away, then recall.
    eq.active.value = { enabled: false, preampDb: 0, bands: [] }

    eq.applyPreset(id)

    expect(store.settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(bassBoost)
    expect(eq.appliedPresetId.value).toBe(id)
  })

  it('renaming a preset preserves its id', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const id = eq.savePreset('Bass boost')

    eq.renamePreset(id, 'Deep bass')

    const reloaded = state(store.settings)
    expect(reloaded.presets.value).toEqual([{ id, name: 'Deep bass', spec: expect.anything() }])
  })

  it('deleting a preset leaves the others’ ids untouched', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const keep = eq.savePreset('Keep')
    const drop = eq.savePreset('Drop')

    eq.deletePreset(drop)

    expect(eq.presets.value.map((p) => p.id)).toEqual([keep])
  })

  it('allows two presets with the same name, both surviving a reload', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.savePreset('Car')
    eq.savePreset('Car')

    const reloaded = state(store.settings)
    const cars = reloaded.presets.value.filter((p) => p.name === 'Car')
    expect(cars).toHaveLength(2)
    expect(new Set(cars.map((p) => p.id)).size).toBe(2)
  })

  it('is not dirty right after saving or applying, and dirty once the curve drifts', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost
    const id = eq.savePreset('Bass boost')

    expect(eq.dirty.value).toBe(false)

    eq.active.value = { ...bassBoost, preampDb: -6 }
    expect(eq.dirty.value).toBe(true)

    eq.applyPreset(id)
    expect(eq.dirty.value).toBe(false)
  })

  it('has no dirty state and no applied preset before one is selected', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost

    expect(eq.appliedPreset.value).toBeNull()
    expect(eq.dirty.value).toBe(false)
  })

  it('clears the selection when the applied preset is deleted', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const id = eq.savePreset('Bass boost')
    expect(eq.appliedPresetId.value).toBe(id)

    eq.deletePreset(id)

    expect(eq.appliedPresetId.value).toBeNull()
  })

  it('writes the enabled key without disturbing the stored bands', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost

    eq.enabled.value = true

    expect(eq.enabled.value).toBe(true)
    expect(store.settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key).bands).toHaveLength(1)
    expect(store.settings.get<readonly unknown[]>(AUDIO_EQ_PRESETS.key)).toEqual([])
  })

  it('the master toggle writes audio.eq.enabled and nothing else', () => {
    const store = settingsStoreFixture()
    const counting = countingSettings(store.settings)
    const eq = state(counting.settings)

    eq.enabled.value = true

    expect(counting.writes).toEqual([AUDIO_EQ_ENABLED.key])
  })

  it('writes audio.eq.active exactly once for one curve change', () => {
    const store = settingsStoreFixture()
    const counting = countingSettings(store.settings)
    const eq = state(counting.settings)

    eq.active.value = bassBoost

    expect(counting.writes).toEqual([AUDIO_EQ_ACTIVE.key])
  })

  it('overwrites a preset in place, keeping its id and name and clearing dirty', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost
    const id = eq.savePreset('Bass boost')

    const edited: EqualizerSpec = { ...bassBoost, preampDb: -6 }
    eq.active.value = edited
    expect(eq.dirty.value).toBe(true)

    eq.updatePreset(id)

    expect(eq.dirty.value).toBe(false)
    expect(eq.appliedPresetId.value).toBe(id)
    const reloaded = state(store.settings)
    expect(reloaded.presets.value).toEqual([{ id, name: 'Bass boost', spec: edited }])
  })

  it('updatePreset ignores an unknown id', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const id = eq.savePreset('Bass boost')

    eq.updatePreset('nope')

    expect(eq.presets.value.map((p) => p.id)).toEqual([id])
  })

  it('setPreamp writes only the pre-amp, carrying the bands through', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost

    eq.setPreamp(-9)

    expect(eq.active.value.preampDb).toBe(-9)
    expect(eq.active.value.bands).toEqual(bassBoost.bands)
    expect(eq.active.value.enabled).toBe(true)
  })

  it('setPreamp clamps to the node range and drops a non-finite value', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost

    eq.setPreamp(-100)
    expect(eq.active.value.preampDb).toBe(-24)
    eq.setPreamp(100)
    expect(eq.active.value.preampDb).toBe(24)

    eq.setPreamp(Number.NaN)
    // Unchanged: a NaN mid-keystroke must not reach the settings validator.
    expect(eq.active.value.preampDb).toBe(24)
  })
})

describe('createEqualizerState undo/redo', () => {
  it('undoes and redoes a curve change, restoring the exact spec', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const initial = eq.active.value

    eq.active.value = bassBoost
    expect(eq.canUndo.value).toBe(true)
    expect(eq.canRedo.value).toBe(false)

    eq.undo()
    expect(eq.active.value).toEqual(initial)
    expect(eq.canUndo.value).toBe(false)
    expect(eq.canRedo.value).toBe(true)

    eq.redo()
    expect(eq.active.value).toEqual(bassBoost)
    expect(eq.canRedo.value).toBe(false)
  })

  it('records a bracketed drag as a single undo step, not one per write', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const initial = eq.active.value

    // A drag: many intermediate writes between begin and end.
    eq.beginInteractive()
    eq.active.value = { ...bassBoost, bands: bandsAt(100) }
    eq.active.value = { ...bassBoost, bands: bandsAt(200) }
    const landed = { ...bassBoost, bands: bandsAt(300) }
    eq.active.value = landed
    eq.endInteractive()

    expect(eq.active.value).toEqual(landed)
    // One step: a single undo returns to before the drag, and there is no more.
    eq.undo()
    expect(eq.active.value).toEqual(initial)
    expect(eq.canUndo.value).toBe(false)
  })

  it('drops the redo stack once a new edit forks the timeline', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const a = { ...bassBoost, preampDb: -3 }
    const b = { ...bassBoost, preampDb: -6 }
    const c = { ...bassBoost, preampDb: -9 }

    eq.active.value = a
    eq.active.value = b
    eq.undo()
    expect(eq.active.value).toEqual(a)
    expect(eq.canRedo.value).toBe(true)

    eq.active.value = c
    expect(eq.canRedo.value).toBe(false)
    eq.undo()
    expect(eq.active.value).toEqual(a)
  })

  it('does nothing when there is nothing to undo or redo', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    const initial = eq.active.value

    eq.undo()
    eq.redo()
    expect(eq.active.value).toEqual(initial)
    expect(eq.canUndo.value).toBe(false)
    expect(eq.canRedo.value).toBe(false)
  })

  it('makes a recalled preset undoable back to the hand-edited curve', () => {
    const store = settingsStoreFixture()
    const eq = state(store.settings)
    eq.active.value = bassBoost
    const id = eq.savePreset('Bass boost')
    const edited = { ...bassBoost, preampDb: -8 }
    eq.active.value = edited

    eq.applyPreset(id)
    expect(eq.active.value).toEqual(bassBoost)

    // The recall is one step: undo lands back on the edit the operator was on.
    eq.undo()
    expect(eq.active.value).toEqual(edited)
  })
})

describe('createEqualizerState in-situ override editing (W19-11)', () => {
  it('with the mode off, editing writes the global even when an override is present', () => {
    const store = settingsStoreFixture()
    const counting = countingSettings(store.settings)
    const override = shallowRef<EqualizerSpec | null>(trebleLift)
    const eq = createEqualizerState(counting.settings, { newId: sequentialIds(), override })

    expect(eq.editingOverrideActive.value).toBe(false)
    eq.active.value = bassBoost

    // The global was written; the override ref is untouched.
    expect(counting.writes).toEqual([AUDIO_EQ_ACTIVE.key])
    expect(override.value).toEqual(trebleLift)
    expect(store.settings.get<EqualizerSpec>(AUDIO_EQ_ACTIVE.key)).toEqual(bassBoost)
  })

  it('with the mode on and an override present, editing writes the override and never the global', () => {
    const store = settingsStoreFixture()
    const counting = countingSettings(store.settings)
    const override = shallowRef<EqualizerSpec | null>(trebleLift)
    const eq = createEqualizerState(counting.settings, { newId: sequentialIds(), override })

    eq.editingOverride.value = true
    expect(eq.editingOverrideActive.value).toBe(true)
    // The editor now shows the override, not the global.
    expect(eq.active.value).toEqual(trebleLift)

    const edited = { ...trebleLift, preampDb: -4 }
    eq.active.value = edited

    expect(override.value).toEqual(edited)
    // `audio.eq.active` was never written — the derived-layer invariant holds.
    expect(counting.writes).not.toContain(AUDIO_EQ_ACTIVE.key)
  })

  it('with the mode on but no override, editing falls through to the global', () => {
    const store = settingsStoreFixture()
    const counting = countingSettings(store.settings)
    const override = shallowRef<EqualizerSpec | null>(null)
    const eq = createEqualizerState(counting.settings, { newId: sequentialIds(), override })

    eq.editingOverride.value = true
    expect(eq.hasOverride.value).toBe(false)
    expect(eq.editingOverrideActive.value).toBe(false)

    eq.active.value = bassBoost

    expect(counting.writes).toEqual([AUDIO_EQ_ACTIVE.key])
    expect(override.value).toBeNull()
  })

  it('toggling into an override re-derives the selector to the override’s preset', () => {
    const store = settingsStoreFixture()
    const override = shallowRef<EqualizerSpec | null>(null)
    const eq = createEqualizerState(store.settings, { newId: sequentialIds(), override })

    // Two presets; the global rests on A while the override carries B's curve.
    eq.active.value = bassBoost
    const a = eq.savePreset('A')
    eq.active.value = trebleLift
    eq.savePreset('B')
    eq.applyPreset(a)
    expect(eq.appliedPresetId.value).toBe(a)

    override.value = { ...trebleLift }
    eq.editingOverride.value = true

    // The selector names the override's preset (B), not the global's (A).
    expect(eq.appliedPreset.value?.name).toBe('B')
    expect(eq.dirty.value).toBe(false)
  })

  it('a context switch re-baselines undo history so undo does not step across it', () => {
    const store = settingsStoreFixture()
    const override = shallowRef<EqualizerSpec | null>(trebleLift)
    const eq = createEqualizerState(store.settings, { newId: sequentialIds(), override })

    // An edit on the global builds one undo step.
    eq.active.value = bassBoost
    expect(eq.canUndo.value).toBe(true)

    // Flipping the mode is a context switch, not an edit: history resets to the
    // override curve, so there is nothing to undo back into the global.
    eq.editingOverride.value = true
    expect(eq.active.value).toEqual(trebleLift)
    expect(eq.canUndo.value).toBe(false)
  })

  it('saving while editing an override writes the preset, not the global', () => {
    const store = settingsStoreFixture()
    const counting = countingSettings(store.settings)
    const override = shallowRef<EqualizerSpec | null>(trebleLift)
    const eq = createEqualizerState(counting.settings, { newId: sequentialIds(), override })

    eq.editingOverride.value = true
    const id = eq.savePreset('From override')

    expect(eq.presets.value).toEqual([{ id, name: 'From override', spec: trebleLift }])
    expect(counting.writes).toEqual([AUDIO_EQ_PRESETS.key])
  })
})

describe('createClipLatch', () => {
  it('lights on a sample at full scale and not on one just below', () => {
    const litLatch = createClipLatch()
    litLatch.push(1.0, 0)
    expect(litLatch.lit).toBe(true)

    const quietLatch = createClipLatch()
    quietLatch.push(0.99, 0)
    expect(quietLatch.lit).toBe(false)
    // The threshold is exactly `CLIP_THRESHOLD`.
    quietLatch.push(CLIP_THRESHOLD, 0)
    expect(quietLatch.lit).toBe(true)
  })

  it('holds for the stated duration and then clears on its own', () => {
    const latch = createClipLatch()
    latch.push(1.0, 1000)
    // Still within the hold window.
    latch.push(0, 1000 + DEFAULT_CLIP_HOLD_MS - 1)
    expect(latch.lit).toBe(true)
    // The window has elapsed.
    latch.push(0, 1000 + DEFAULT_CLIP_HOLD_MS)
    expect(latch.lit).toBe(false)
  })

  it('re-arms the hold on a later clip', () => {
    const latch = createClipLatch({ holdMs: 100 })
    latch.push(1.0, 0)
    latch.push(1.0, 90) // fresh clip pushes the window forward
    latch.push(0, 150) // would have expired at 100, but 90 + 100 = 190
    expect(latch.lit).toBe(true)
    latch.push(0, 190)
    expect(latch.lit).toBe(false)
  })

  it('clears immediately when the operator acknowledges it', () => {
    const latch = createClipLatch()
    latch.push(1.0, 0)
    expect(latch.lit).toBe(true)
    latch.clear()
    expect(latch.lit).toBe(false)
  })
})
