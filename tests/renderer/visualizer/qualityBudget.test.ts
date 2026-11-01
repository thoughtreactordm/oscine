import { describe, expect, it } from 'vitest'
import {
  AUTO_CAP_PIXELS,
  BACKOFF_SEC,
  createQualityGovernor,
  internalSize,
  LOW_CAP_PIXELS,
  LOW_FRAME_MS,
  MAX_SAMPLE_MS,
  OVER_BUDGET_FACTOR,
  renderProfile,
  TARGET_FRAME_MS,
  UNDER_BUDGET_FACTOR
} from '../../../src/renderer/visualizer/qualityBudget'

/** W23-8, D35.6 / R16: the WebGL tier's resolution budget and the `auto` backoff. */

function feed(
  governor: ReturnType<typeof createQualityGovernor>,
  frameMs: number,
  seconds: number
): boolean {
  let changed = false
  const frames = Math.round((seconds * 1000) / frameMs)
  for (let index = 0; index < frames; index++) changed = governor.observe(frameMs) || changed
  return changed
}

describe('renderProfile', () => {
  it('caps resolution and frame rate by tier', () => {
    expect(renderProfile('auto')).toEqual({ capPixels: AUTO_CAP_PIXELS, minFrameMs: 0 })
    expect(renderProfile('low')).toEqual({ capPixels: LOW_CAP_PIXELS, minFrameMs: LOW_FRAME_MS })
    expect(renderProfile('high')).toEqual({ capPixels: Infinity, minFrameMs: 0 })
    expect(AUTO_CAP_PIXELS).toBe(1920 * 1080)
  })

  it('auto, backed off, behaves like low; the other tiers ignore the flag', () => {
    expect(renderProfile('auto', true)).toEqual(renderProfile('low'))
    expect(renderProfile('high', true)).toEqual(renderProfile('high'))
  })
})

describe('internalSize', () => {
  it('leaves a canvas under the cap at its own size', () => {
    expect(internalSize(1280, 720, AUTO_CAP_PIXELS)).toEqual({ width: 1280, height: 720 })
    expect(internalSize(1920, 1080, AUTO_CAP_PIXELS)).toEqual({ width: 1920, height: 1080 })
  })

  it('scales a 4K Zen canvas down to the cap, keeping the aspect', () => {
    const size = internalSize(3840, 2160, AUTO_CAP_PIXELS)
    expect(size).toEqual({ width: 1920, height: 1080 })
    const low = internalSize(3840, 2160, LOW_CAP_PIXELS)
    expect(low.width * low.height).toBeLessThanOrEqual(LOW_CAP_PIXELS)
    expect(low.width / low.height).toBeCloseTo(16 / 9, 2)
  })

  it('never lands over the cap through rounding, nor below a pixel', () => {
    for (const [w, h] of [
      [2561, 1439],
      [3001, 1999],
      [5120, 1440]
    ]) {
      const size = internalSize(w, h, LOW_CAP_PIXELS)
      expect(size.width * size.height).toBeLessThanOrEqual(LOW_CAP_PIXELS)
    }
    expect(internalSize(0, 0, LOW_CAP_PIXELS)).toEqual({ width: 1, height: 1 })
  })

  it('high is native', () => {
    expect(internalSize(7680, 4320, Infinity)).toEqual({ width: 7680, height: 4320 })
  })
})

describe('the auto backoff', () => {
  const over = TARGET_FRAME_MS * OVER_BUDGET_FACTOR * 1.2
  const between = TARGET_FRAME_MS * ((OVER_BUDGET_FACTOR + UNDER_BUDGET_FACTOR) / 2)

  it('holds at 60 fps indefinitely', () => {
    const governor = createQualityGovernor('auto')
    expect(feed(governor, TARGET_FRAME_MS, 30)).toBe(false)
    expect(governor.backedOff).toBe(false)
    expect(governor.profile).toEqual(renderProfile('auto'))
  })

  it('backs off to low once the average has stayed over budget for two seconds', () => {
    const governor = createQualityGovernor('auto')
    feed(governor, TARGET_FRAME_MS, 1)
    expect(feed(governor, over, BACKOFF_SEC * 0.8)).toBe(false)
    expect(feed(governor, over, BACKOFF_SEC * 0.6)).toBe(true)
    expect(governor.backedOff).toBe(true)
    expect(governor.profile).toEqual(renderProfile('low'))
  })

  it('a dip back under budget restarts the count', () => {
    const governor = createQualityGovernor('auto')
    feed(governor, over, BACKOFF_SEC * 0.8)
    feed(governor, TARGET_FRAME_MS, 2)
    expect(feed(governor, over, BACKOFF_SEC * 0.8)).toBe(false)
    expect(governor.backedOff).toBe(false)
  })

  it('in the band between the thresholds the count holds rather than resets', () => {
    const governor = createQualityGovernor('auto')
    // Each leg alone is well short of the two seconds (the average's own decay
    // through the threshold adds a little to the first).
    feed(governor, over, BACKOFF_SEC * 0.4)
    // Long enough for the average to settle into the band, not under it.
    feed(governor, between, 3)
    expect(governor.backedOff).toBe(false)
    expect(feed(governor, over, BACKOFF_SEC * 0.4)).toBe(true)

    const fresh = createQualityGovernor('auto')
    expect(feed(fresh, over, BACKOFF_SEC * 0.4)).toBe(false)
  })

  it('hitches are clamped, so an occasional stall never backs off', () => {
    const governor = createQualityGovernor('auto')
    for (let second = 0; second < 20; second++) {
      feed(governor, TARGET_FRAME_MS, 0.5)
      governor.observe(400)
      feed(governor, TARGET_FRAME_MS, 0.5)
    }
    expect(governor.backedOff).toBe(false)
    expect(MAX_SAMPLE_MS).toBeLessThan(100)
  })

  it('stays backed off until reset or a quality change', () => {
    const governor = createQualityGovernor('auto')
    feed(governor, over, BACKOFF_SEC * 2)
    expect(governor.backedOff).toBe(true)
    // At 30 fps the interval says nothing about headroom: no climbing back.
    feed(governor, TARGET_FRAME_MS, 10)
    expect(governor.backedOff).toBe(true)
    governor.reset()
    expect(governor.backedOff).toBe(false)
    expect(governor.averageMs).toBe(0)

    feed(governor, over, BACKOFF_SEC * 2)
    governor.setQuality('high')
    expect(governor.backedOff).toBe(false)
    governor.setQuality('auto')
    expect(governor.profile).toEqual(renderProfile('auto'))
  })

  it('only auto backs off', () => {
    for (const quality of ['low', 'high'] as const) {
      const governor = createQualityGovernor(quality)
      expect(feed(governor, over, BACKOFF_SEC * 3)).toBe(false)
      expect(governor.profile).toEqual(renderProfile(quality))
    }
  })

  it('ignores nonsense samples', () => {
    const governor = createQualityGovernor('auto')
    expect(governor.observe(0)).toBe(false)
    expect(governor.observe(-5)).toBe(false)
    expect(governor.observe(Number.NaN)).toBe(false)
    expect(governor.averageMs).toBe(0)
  })
})
