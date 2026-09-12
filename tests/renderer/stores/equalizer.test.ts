import { describe, expect, it } from 'vitest'
import { computed, type WritableComputedRef } from 'vue'
import { AUDIO_EQ_ACTIVE, AUDIO_EQ_ENABLED, AUDIO_EQ_PRESETS } from '@shared/settings'
import type { EqualizerSpec } from '@shared/audio/equalizer'
import {
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
})
