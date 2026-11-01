import { describe, expect, it, vi } from 'vitest'
import {
  createGlAvailability,
  MAX_CONTEXT_LOSSES
} from '../../../src/renderer/visualizer/glAvailability'
import { resolveEffect } from '../../../src/renderer/visualizer/gate'
import { cycleEffect, stepEffect } from '../../../src/renderer/visualizer/selection'

/**
 * W23-8, D35.6 / R16: which effects can run this session. The WebGL2 tier
 * fails into 2D — a failed probe, a failed shader, a lost context — and the
 * controls only ever see what survives.
 */

const BARS = { id: 'bars', surface: '2d' as const }
const HALO = { id: 'halo', surface: '2d' as const }
const PLUME = { id: 'plume', surface: 'webgl2' as const }
const DRIFT = { id: 'drift', surface: 'webgl2' as const }
const REGISTRY = [BARS, PLUME, HALO, DRIFT]

describe('the capability probe', () => {
  it('runs lazily, once per session', () => {
    const probe = vi.fn(() => true)
    const availability = createGlAvailability(probe)
    expect(probe).not.toHaveBeenCalled()
    expect(availability.state).toBe('unknown')
    expect(availability.isAvailable(BARS)).toBe(true)
    // A 2D question never needs a context.
    expect(probe).not.toHaveBeenCalled()
    expect(availability.filter(REGISTRY)).toEqual(REGISTRY)
    availability.filter(REGISTRY)
    availability.tierAvailable()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(availability.state).toBe('available')
  })

  it('a failed probe leaves only the 2D effects, in registry order', () => {
    const availability = createGlAvailability(() => false)
    expect(availability.filter(REGISTRY)).toEqual([BARS, HALO])
    expect(availability.state).toBe('unavailable')
  })

  it('a probe that throws counts as failed', () => {
    const availability = createGlAvailability(() => {
      throw new Error('no canvas')
    })
    expect(availability.tierAvailable()).toBe(false)
    expect(availability.filter(REGISTRY)).toEqual([BARS, HALO])
  })

  it('a context that cannot be created after a good probe turns the tier off', () => {
    const availability = createGlAvailability(() => true)
    const before = availability.version
    availability.markTierFailed()
    expect(availability.version).toBeGreaterThan(before)
    expect(availability.filter(REGISTRY)).toEqual([BARS, HALO])
  })
})

describe('a compile failure', () => {
  it('removes only that effect, and says so once', () => {
    const availability = createGlAvailability(() => true)
    expect(availability.markEffectFailed('plume')).toBe(true)
    expect(availability.markEffectFailed('plume')).toBe(false)
    expect(availability.filter(REGISTRY)).toEqual([BARS, HALO, DRIFT])
    expect(availability.state).toBe('available')
  })
})

describe('context loss', () => {
  it('suspends the tier until restored, then brings it back', () => {
    const availability = createGlAvailability(() => true)
    availability.filter(REGISTRY)
    expect(availability.contextLost()).toBe(false)
    expect(availability.state).toBe('suspended')
    expect(availability.filter(REGISTRY)).toEqual([BARS, HALO])
    availability.contextRestored()
    expect(availability.state).toBe('available')
    expect(availability.filter(REGISTRY)).toEqual(REGISTRY)
  })

  it(`${MAX_CONTEXT_LOSSES} losses in a session turn the tier off until restart`, () => {
    const availability = createGlAvailability(() => true)
    availability.contextLost()
    availability.contextRestored()
    expect(availability.contextLost()).toBe(true)
    availability.contextRestored()
    expect(availability.state).toBe('unavailable')
    expect(availability.filter(REGISTRY)).toEqual([BARS, HALO])
    // A third loss is not news.
    expect(availability.contextLost()).toBe(false)
  })

  it('every change moves the version, so a reactive wrapper sees it', () => {
    const availability = createGlAvailability(() => true)
    const seen = [availability.version]
    availability.contextLost()
    seen.push(availability.version)
    availability.contextRestored()
    seen.push(availability.version)
    availability.contextRestored() // not lost: nothing to report
    seen.push(availability.version)
    expect(seen).toEqual([0, 1, 2, 2])
  })
})

describe('a stored WebGL effect on a machine that lost the tier', () => {
  it('falls back to the first available effect at runtime, and the controls skip it', () => {
    const availability = createGlAvailability(() => false)
    const available = availability.filter(REGISTRY)
    // The stored id is unknown to the available list: it resolves, it is not rewritten.
    expect(resolveEffect(available, 'plume')).toBe(BARS)
    expect(stepEffect(available, 'plume', 1)).toBe(HALO)
    expect(stepEffect(available, 'bars', 1)).toBe(HALO)
    expect(stepEffect(available, 'halo', 1)).toBe(BARS)
    expect(cycleEffect(available, 'halo', 'shuffle', () => 0.99)).toBe(BARS)
  })
})
