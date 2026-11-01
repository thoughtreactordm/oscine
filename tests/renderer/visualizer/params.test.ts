import { describe, expect, it } from 'vitest'
import {
  formatParam,
  multiplierParam,
  resolveParams,
  withParam,
  withoutParams,
  writeParams,
  type EffectParamSpec
} from '../../../src/renderer/visualizer/params'
import { parseVisualizerParams } from '../../../src/shared/settings'

/**
 * The visualizer's effect knobs: how stored values become the live object an
 * effect reads, and how a slider move becomes the stored record.
 */

const SPEED = multiplierParam('speed', 'Speed', undefined, { min: 0, max: 3 })
const SIZE = multiplierParam('size', 'Size')
const SPECS: readonly EffectParamSpec[] = [SPEED, SIZE]

describe('resolveParams', () => {
  it('is every default when nothing is stored', () => {
    expect(resolveParams(SPECS, undefined)).toEqual({ speed: 1, size: 1 })
  })

  it('takes stored values, clamped into the knob range', () => {
    expect(resolveParams(SPECS, { speed: 2.5, size: 9 })).toEqual({ speed: 2.5, size: 2 })
    expect(resolveParams(SPECS, { size: 0 })).toEqual({ speed: 1, size: 0.25 })
  })

  it('ignores stored keys that are not knobs any more', () => {
    expect(resolveParams(SPECS, { gone: 4 })).toEqual({ speed: 1, size: 1 })
  })
})

describe('writeParams', () => {
  it('updates the same object in place, so an effect holding it sees the change', () => {
    const live = resolveParams(SPECS, undefined)
    const held = live
    writeParams(live, SPECS, { speed: 0.5 })
    expect(held).toBe(live)
    expect(held.speed).toBe(0.5)
    writeParams(live, SPECS, undefined)
    expect(held.speed).toBe(1)
  })

  it('drops keys the specs no longer declare', () => {
    const live: Record<string, number> = { speed: 1, stale: 3 }
    writeParams(live, SPECS, undefined)
    expect(Object.keys(live).sort()).toEqual(['size', 'speed'])
  })
})

describe('withParam / withoutParams', () => {
  it('stores only what differs from the default', () => {
    const moved = withParam({}, 'halo', SPEED, 2)
    expect(moved).toEqual({ halo: { speed: 2 } })
    expect(withParam(moved, 'halo', SPEED, 1)).toEqual({})
  })

  it('clamps before storing and leaves other effects alone', () => {
    const start = { bars: { height: 0.5 } }
    expect(withParam(start, 'halo', SIZE, 7)).toEqual({ bars: { height: 0.5 }, halo: { size: 2 } })
  })

  it('resets one effect, and is a no-op for an untuned one', () => {
    const start = { bars: { height: 0.5 }, halo: { size: 2 } }
    expect(withoutParams(start, 'halo')).toEqual({ bars: { height: 0.5 } })
    expect(withoutParams(start, 'silk')).toBe(start)
  })
})

describe('formatParam', () => {
  it('prints a multiplier with its sign and a plain number without', () => {
    expect(formatParam(SPEED, 1.25)).toBe('1.25×')
    expect(formatParam({ ...SPEED, format: 'number', step: 1 }, 12)).toBe('12')
  })
})

describe('parseVisualizerParams', () => {
  it('rejects a non-record', () => {
    expect(parseVisualizerParams(null)).toBeNull()
    expect(parseVisualizerParams([1])).toBeNull()
    expect(parseVisualizerParams('x')).toBeNull()
  })

  it('keeps unknown effect ids and drops malformed entries', () => {
    expect(
      parseVisualizerParams({
        halo: { size: 1.5, bad: 'x', inf: Infinity },
        future: { knob: 2 },
        broken: 3,
        empty: { nope: null }
      })
    ).toEqual({ halo: { size: 1.5 }, future: { knob: 2 } })
  })
})
