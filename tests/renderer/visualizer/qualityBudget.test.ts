import { describe, expect, it } from 'vitest'
import {
  AUTO_CAP_PIXELS,
  BACKOFF_SEC,
  createQualityGovernor,
  createVsyncEstimator,
  frameDue,
  internalSize,
  LOW_CAP_PIXELS,
  LOW_FPS,
  MAX_SAMPLE_MS,
  OVER_BUDGET_FACTOR,
  renderProfile,
  TARGET_FPS,
  TARGET_FRAME_MS,
  UNDER_BUDGET_FACTOR,
  vsyncsPerFrame
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
    expect(renderProfile('auto')).toEqual({ capPixels: AUTO_CAP_PIXELS, fps: TARGET_FPS })
    expect(renderProfile('low')).toEqual({ capPixels: LOW_CAP_PIXELS, fps: LOW_FPS })
    expect(renderProfile('high')).toEqual({ capPixels: Infinity, fps: TARGET_FPS })
    expect(AUTO_CAP_PIXELS).toBe(1920 * 1080)
  })

  it('auto, backed off, behaves like low; the other tiers ignore the flag', () => {
    expect(renderProfile('auto', true)).toEqual(renderProfile('low'))
    expect(renderProfile('high', true)).toEqual(renderProfile('high'))
  })
})

/**
 * The host's pacing over ten seconds of vsyncs at `hz`, each timestamp
 * jittered by up to ±`jitterMs`, learning the refresh as it goes. Chromium's
 * rAF timestamps are BeginFrame times, measured at ±0.1 ms on a 240 Hz panel;
 * the default is five times that. (The half-vsync margin in `frameDue` takes
 * up to a quarter of a vsync each way, ±1 ms at 240 Hz.)
 */
function renderedFps(hz: number, fps: number, jitterMs = 0.5): number {
  const interval = 1000 / hz
  const estimator = createVsyncEstimator()
  let seed = 0x9e3779b9
  const jitter = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return (seed / 4294967296 - 0.5) * 2 * jitterMs
  }
  let lastVsync = 0
  let lastRendered = 0
  let rendered = 0
  for (let vsync = 1; vsync <= hz * 10; vsync++) {
    const now = vsync * interval + jitter()
    if (lastVsync !== 0) estimator.observe(now - lastVsync)
    lastVsync = now
    if (lastRendered === 0 || frameDue(now - lastRendered, estimator.vsyncMs, fps)) {
      rendered++
      lastRendered = now
    }
  }
  return Math.round(rendered / 10)
}

describe('frame pacing', () => {
  it('lands 60 fps on a whole divisor of every common refresh', () => {
    const expected: [number, number][] = [
      [60, 60],
      [75, 75],
      [90, 90],
      [100, 100],
      [120, 60],
      [144, 72],
      [165, 83],
      [240, 60],
      [360, 60]
    ]
    // Within a frame a second: at 360 Hz the test's jitter is a fifth of a vsync.
    for (const [hz, fps] of expected) {
      expect(Math.abs(renderedFps(hz, TARGET_FPS) - fps), `${hz} Hz`).toBeLessThanOrEqual(1)
    }
  })

  it('lands 30 fps the same way', () => {
    expect(renderedFps(60, LOW_FPS)).toBe(30)
    expect(renderedFps(144, LOW_FPS)).toBe(36)
    expect(renderedFps(240, LOW_FPS)).toBe(30)
  })

  it('takes a refresh a hair under nominal as the nominal one', () => {
    expect(vsyncsPerFrame(1000 / 59.94, TARGET_FPS)).toBe(1)
    expect(vsyncsPerFrame(1000 / 119.88, TARGET_FPS)).toBe(2)
  })

  it('renders every vsync before it knows the refresh', () => {
    expect(frameDue(0.1, 0, TARGET_FPS)).toBe(true)
  })
})

describe('the vsync estimator', () => {
  it('learns the refresh and shrugs off a missed vsync', () => {
    const estimator = createVsyncEstimator()
    for (let n = 0; n < 50; n++) estimator.observe(1000 / 240)
    estimator.observe((1000 / 240) * 3)
    expect(estimator.vsyncMs).toBeCloseTo(1000 / 240, 3)
  })

  it('follows the window to a slower or a faster display', () => {
    const estimator = createVsyncEstimator()
    for (let n = 0; n < 50; n++) estimator.observe(1000 / 240)
    for (let n = 0; n < 40; n++) estimator.observe(1000 / 60)
    expect(estimator.vsyncMs).toBeCloseTo(1000 / 60, 1)
    for (let n = 0; n < 40; n++) estimator.observe(1000 / 144)
    expect(estimator.vsyncMs).toBeCloseTo(1000 / 144, 1)
  })

  it('ignores nonsense', () => {
    const estimator = createVsyncEstimator()
    estimator.observe(0)
    estimator.observe(-5)
    estimator.observe(Number.NaN)
    estimator.observe(5000)
    expect(estimator.vsyncMs).toBe(0)
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
