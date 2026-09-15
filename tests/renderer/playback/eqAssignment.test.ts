import { describe, expect, it } from 'vitest'
import type { EqualizerPreset, EqualizerSpec } from '../../../src/shared/audio/equalizer'
import {
  pickAssignedPresetId,
  resolveEqAssignment,
  type AssignmentLayer
} from '../../../src/renderer/playback/eqAssignment'

const spec = (preampDb: number): EqualizerSpec => ({
  enabled: true,
  preampDb,
  bands: [{ id: 'b1', type: 'peaking', frequencyHz: 1000, gainDb: 3, q: 1, enabled: true }]
})

const preset = (id: string, name: string, preampDb = 0): EqualizerPreset => ({
  id,
  name,
  spec: spec(preampDb)
})

const layer = (overridden: boolean, value: string | null): AssignmentLayer => ({
  overridden,
  value
})

describe('pickAssignedPresetId', () => {
  it('takes the most specific level that carries a row of its own', () => {
    // album, then artist, then playlist — album wins.
    const winner = pickAssignedPresetId([
      layer(true, 'album-preset'),
      layer(true, 'artist-preset'),
      layer(true, 'playlist-preset')
    ])
    expect(winner).toBe('album-preset')
  })

  it('falls through a level with no row of its own to the next that has one', () => {
    const winner = pickAssignedPresetId([
      layer(false, 'inherited'),
      layer(true, 'artist-preset'),
      layer(true, 'playlist-preset')
    ])
    expect(winner).toBe('artist-preset')
  })

  it('resolves to the global floor when no level is overridden', () => {
    // Every level inherits the same global value; with none overridden the floor
    // is what plays — here, no assignment.
    const winner = pickAssignedPresetId([
      layer(false, null),
      layer(false, null),
      layer(false, null)
    ])
    expect(winner).toBeNull()
  })

  it('honours a global assignment inherited by every level', () => {
    const winner = pickAssignedPresetId([
      layer(false, 'global-preset'),
      layer(false, 'global-preset')
    ])
    expect(winner).toBe('global-preset')
  })

  it('is null for no levels at all', () => {
    expect(pickAssignedPresetId([])).toBeNull()
  })
})

describe('resolveEqAssignment', () => {
  const presets = [preset('p1', 'Bass boost', 6), preset('p2', 'Vocal', -2)]

  it('maps a live id to its preset spec', () => {
    const resolved = resolveEqAssignment('p1', presets)
    expect(resolved).toEqual({ presetId: 'p1', spec: presets[0].spec, dangling: false })
  })

  it('is no assignment for a null id', () => {
    expect(resolveEqAssignment(null, presets)).toEqual({
      presetId: null,
      spec: null,
      dangling: false
    })
  })

  it('dangles an id that names no live preset — spec null, reported', () => {
    // Deleting the preset an album referenced must leave it playing flat, and be
    // reportable as dangling, not resolve to an error or the wrong curve.
    const resolved = resolveEqAssignment('deleted', presets)
    expect(resolved).toEqual({ presetId: 'deleted', spec: null, dangling: true })
  })

  it('references by id, so a rename does not reassign', () => {
    // The same id, a preset renamed: still resolves, still to the same spec.
    const renamed = [{ ...presets[0], name: 'Deep bass' }, presets[1]]
    expect(resolveEqAssignment('p1', renamed).spec).toBe(renamed[0].spec)
    // A value that was the *name* would now dangle; the id does not.
    expect(resolveEqAssignment('Bass boost', renamed).dangling).toBe(true)
  })
})
