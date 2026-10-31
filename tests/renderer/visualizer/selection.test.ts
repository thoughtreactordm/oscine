import { describe, expect, it } from 'vitest'
import { resolveEffect } from '../../../src/renderer/visualizer/gate'
import { cycleEffect, stepEffect } from '../../../src/renderer/visualizer/selection'

/**
 * W23-6, D35.5: which effect next/previous and the track-change cycle move to.
 * The registry here is the *available* list — an unavailable effect is simply
 * absent from it, which is what `availableEffects()` hands the controls.
 */

const fx = (id: string) => ({ id })
const A = fx('a')
const B = fx('b')
const C = fx('c')
const ALL = [A, B, C]
// The full registry is a, b, c, d; d is unavailable (say, a WebGL effect on a
// machine that failed the probe), so it is not in the list the controls see.
const WITH_UNAVAILABLE_STORED = 'd'

describe('stepEffect', () => {
  it('steps forward and back in registry order', () => {
    expect(stepEffect(ALL, 'a', 1)).toBe(B)
    expect(stepEffect(ALL, 'b', 1)).toBe(C)
    expect(stepEffect(ALL, 'b', -1)).toBe(A)
  })

  it('wraps at both ends', () => {
    expect(stepEffect(ALL, 'c', 1)).toBe(A)
    expect(stepEffect(ALL, 'a', -1)).toBe(C)
  })

  it('steps from the resolved effect when the stored id is unknown or unavailable', () => {
    // The stage shows `a` for an unknown id, so next is `b` and previous wraps to `c`.
    expect(stepEffect(ALL, WITH_UNAVAILABLE_STORED, 1)).toBe(B)
    expect(stepEffect(ALL, 'gone', -1)).toBe(C)
  })

  it('writes nothing with a single available effect, even over an unknown id', () => {
    expect(stepEffect([A], 'a', 1)).toBeNull()
    expect(stepEffect([A], 'a', -1)).toBeNull()
    expect(stepEffect([A], 'gone', 1)).toBeNull()
  })

  it('writes nothing with no effects at all', () => {
    expect(stepEffect([], 'a', 1)).toBeNull()
  })
})

describe('cycleEffect', () => {
  it('does nothing when off', () => {
    expect(cycleEffect(ALL, 'a', 'off')).toBeNull()
  })

  it("advances in registry order on 'track', wrapping", () => {
    expect(cycleEffect(ALL, 'a', 'track')).toBe(B)
    expect(cycleEffect(ALL, 'c', 'track')).toBe(A)
    expect(cycleEffect(ALL, WITH_UNAVAILABLE_STORED, 'track')).toBe(B)
  })

  it("never repeats the current effect on 'shuffle', across the whole random range", () => {
    for (const current of ALL) {
      const seen = new Set<string>()
      for (const r of [0, 0.1, 0.25, 0.49, 0.5, 0.75, 0.999999, 1]) {
        const next = cycleEffect(ALL, current.id, 'shuffle', () => r)
        expect(next).not.toBeNull()
        expect(next).not.toBe(current)
        expect(ALL).toContain(next)
        seen.add(next!.id)
      }
      // Both other effects are reachable.
      expect(seen.size).toBe(2)
    }
  })

  it('shuffles away from the resolved effect when the stored id is unknown', () => {
    for (const r of [0, 0.5, 0.99]) {
      expect(cycleEffect(ALL, 'gone', 'shuffle', () => r)).not.toBe(A)
    }
  })

  it('only ever picks an available effect', () => {
    const available = [A, C] // b unavailable
    expect(cycleEffect(available, 'a', 'track')).toBe(C)
    expect(cycleEffect(available, 'a', 'shuffle', () => 0)).toBe(C)
    expect(cycleEffect(available, 'c', 'shuffle', () => 0.9)).toBe(A)
  })

  it('has nowhere to go with a single available effect', () => {
    expect(cycleEffect([A], 'a', 'track')).toBeNull()
    expect(cycleEffect([A], 'a', 'shuffle', () => 0.5)).toBeNull()
  })
})

describe('unknown-id resolution (D35.5)', () => {
  it('resolves to the first available effect and leaves the stored value intact', () => {
    const stored = { value: WITH_UNAVAILABLE_STORED }
    expect(resolveEffect(ALL, stored.value)).toBe(A)
    expect(stepEffect([A], stored.value, 1)).toBeNull()
    expect(cycleEffect([A], stored.value, 'shuffle')).toBeNull()
    expect(stored.value).toBe(WITH_UNAVAILABLE_STORED)
  })
})
