import { describe, expect, it } from 'vitest'
import type { EqualizerSpec } from '@shared/audio/equalizer'
import { createSpecHistory } from '../../../src/renderer/stores/equalizerHistory'

function spec(preampDb: number): EqualizerSpec {
  return { enabled: true, preampDb, bands: [] }
}

const flat = spec(0)

describe('createSpecHistory', () => {
  it('starts with nothing to undo or redo', () => {
    const history = createSpecHistory(flat)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
  })

  it('records a change and undoes to the prior baseline', () => {
    const history = createSpecHistory(flat)
    const boosted = spec(3)

    expect(history.record(boosted)).toBe(true)
    expect(history.canUndo).toBe(true)

    expect(history.undo()).toEqual(flat)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(true)
  })

  it('redoes an undone change', () => {
    const history = createSpecHistory(flat)
    const boosted = spec(3)
    history.record(boosted)
    history.undo()

    expect(history.redo()).toEqual(boosted)
    expect(history.canRedo).toBe(false)
    expect(history.canUndo).toBe(true)
  })

  it('does not record a value equal to the baseline', () => {
    const history = createSpecHistory(flat)
    // A distinct object, structurally identical — a drag that landed where it
    // started, or the echo of our own undo write.
    expect(history.record(spec(0))).toBe(false)
    expect(history.canUndo).toBe(false)
  })

  it('a no-op record leaves the redo stack intact', () => {
    const history = createSpecHistory(flat)
    history.record(spec(3))
    history.undo()
    expect(history.canRedo).toBe(true)

    // The undo write echoes back as a record of the now-current baseline: it must
    // not fork the timeline.
    expect(history.record(flat)).toBe(false)
    expect(history.canRedo).toBe(true)
  })

  it('a fresh change after an undo forks the timeline and drops redo', () => {
    const history = createSpecHistory(flat)
    history.record(spec(3))
    history.undo() // back to flat, redo available
    expect(history.canRedo).toBe(true)

    history.record(spec(6))
    expect(history.canRedo).toBe(false)
    expect(history.undo()).toEqual(flat)
  })

  it('returns null when there is nothing to undo or redo', () => {
    const history = createSpecHistory(flat)
    expect(history.undo()).toBeNull()
    expect(history.redo()).toBeNull()
  })

  it('caps the stack, forgetting the oldest step', () => {
    const history = createSpecHistory(spec(0), { limit: 2 })
    history.record(spec(1))
    history.record(spec(2))
    history.record(spec(3))

    // Three changes, two kept: undo reaches spec(2) and spec(1), then stops — the
    // original spec(0) fell off the bottom.
    expect(history.undo()).toEqual(spec(2))
    expect(history.undo()).toEqual(spec(1))
    expect(history.canUndo).toBe(false)
  })

  it('reset adopts a new baseline and clears both stacks', () => {
    const history = createSpecHistory(flat)
    history.record(spec(3))

    history.reset(spec(9))
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.record(spec(9))).toBe(false) // the new baseline
  })
})
