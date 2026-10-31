import { describe, expect, it } from 'vitest'
import {
  crossfadeAlphas,
  handoffOpacity,
  objectCoverCrop,
  parseCssDurationSec,
  parseWashLook,
  scaledRect,
  WASH_BLUR_PROPERTY,
  WASH_MAX_EDGE,
  WASH_OPACITY_PROPERTY,
  WASH_SATURATE_PROPERTY,
  WASH_SCALE_PROPERTY,
  WASH_TARGET_SIGMA,
  washGeometry,
  washUnderFactor
} from '../../../src/renderer/visualizer/wash'

function reader(values: Record<string, string>) {
  return (property: string) => values[property] ?? ''
}

describe('parseWashLook', () => {
  it('reads the four registered properties as resolved values', () => {
    const look = parseWashLook(
      reader({
        [WASH_BLUR_PROPERTY]: '64px',
        [WASH_SATURATE_PROPERTY]: ' 2.2',
        [WASH_OPACITY_PROPERTY]: '0.198',
        [WASH_SCALE_PROPERTY]: '1.25'
      })
    )
    expect(look).toEqual({ blurPx: 64, saturate: 2.2, opacity: 0.198, scale: 1.25 })
  })

  it('clamps opacity the way CSS does', () => {
    const look = parseWashLook(
      reader({
        [WASH_BLUR_PROPERTY]: '0px',
        [WASH_SATURATE_PROPERTY]: '1',
        [WASH_OPACITY_PROPERTY]: '1.4',
        [WASH_SCALE_PROPERTY]: '1'
      })
    )
    expect(look?.opacity).toBe(1)
  })

  it('refuses an unresolved calc() — the symptom of the properties not being registered', () => {
    expect(
      parseWashLook(
        reader({
          [WASH_BLUR_PROPERTY]: 'calc(var(--oscine-cover-blur) * 1.6)',
          [WASH_SATURATE_PROPERTY]: '2.2',
          [WASH_OPACITY_PROPERTY]: '0.2',
          [WASH_SCALE_PROPERTY]: '1.25'
        })
      )
    ).toBeNull()
    expect(parseWashLook(reader({}))).toBeNull()
  })
})

describe('parseCssDurationSec', () => {
  it('reads ms and s', () => {
    expect(parseCssDurationSec('150ms')).toBeCloseTo(0.15)
    expect(parseCssDurationSec(' 0.2s ')).toBeCloseTo(0.2)
    expect(parseCssDurationSec('0ms')).toBe(0)
    expect(parseCssDurationSec('.5S')).toBeCloseTo(0.5)
  })

  it('rejects what is not a time', () => {
    expect(parseCssDurationSec('')).toBeNull()
    expect(parseCssDurationSec('150')).toBeNull()
    expect(parseCssDurationSec('fast')).toBeNull()
    expect(parseCssDurationSec('-1s')).toBeNull()
  })
})

describe('washGeometry', () => {
  it('blurs the default 64 px wash at ⅛ size, σ = 8', () => {
    const g = washGeometry(1920, 1080, 64)
    expect(g.factor).toBe(8)
    expect(g.width).toBe(240)
    expect(g.height).toBe(135)
    expect(g.blurPx).toBe(WASH_TARGET_SIGMA)
  })

  it('never lets the small canvas grow past its cap, however light the blur', () => {
    const g = washGeometry(3840, 2160, 4)
    expect(Math.max(g.width, g.height)).toBeLessThanOrEqual(WASH_MAX_EDGE)
    expect(g.blurPx * g.factor).toBeCloseTo(4)
  })

  it('does not upsample a small stage', () => {
    const g = washGeometry(200, 100, 0)
    expect(g.factor).toBe(1)
    expect(g.width).toBe(200)
    expect(g.blurPx).toBe(0)
  })
})

describe('objectCoverCrop', () => {
  it('crops a square cover to a wide box from the centre', () => {
    const crop = objectCoverCrop(640, 640, 1920, 1080)
    expect(crop.width).toBe(640)
    expect(crop.height).toBeCloseTo(360)
    expect(crop.x).toBe(0)
    expect(crop.y).toBeCloseTo(140)
  })

  it('crops a wide cover to a tall box from the centre', () => {
    const crop = objectCoverCrop(800, 400, 100, 200)
    expect(crop.height).toBe(400)
    expect(crop.width).toBeCloseTo(200)
    expect(crop.x).toBeCloseTo(300)
  })

  it('keeps the box aspect', () => {
    const crop = objectCoverCrop(1000, 700, 300, 500)
    expect(crop.width / crop.height).toBeCloseTo(300 / 500)
  })
})

describe('scaledRect', () => {
  it('scales about the centre', () => {
    expect(scaledRect(1000, 800, 1.25)).toEqual({ x: -125, y: -100, width: 1250, height: 1000 })
    expect(scaledRect(1000, 800, 1)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
  })
})

describe('crossfadeAlphas', () => {
  it('splits the wash opacity between the two covers, summing to it throughout', () => {
    for (const mix of [0, 0.25, 0.5, 0.9, 1]) {
      const { previous, current } = crossfadeAlphas(mix, 0.2)
      expect(previous + current).toBeCloseTo(0.2)
      expect(current).toBeCloseTo(0.2 * mix)
    }
  })
})

describe('handoffOpacity', () => {
  /** What a canvas at `b` over the `<img>` at `a`, both the same wash, covers. */
  const coverage = (a: number, b: number) => a + b * (1 - a)

  it('keeps the stacked pair covering exactly one wash at every point of the handoff', () => {
    for (const w of [0.05, 0.198, 0.5, 0.95]) {
      for (let h = 0; h <= 1.0001; h += 0.05) {
        const img = w * (1 - h)
        const canvas = handoffOpacity(h, w) * w
        expect(coverage(img, canvas)).toBeCloseTo(w, 10)
      }
    }
  })

  it('is 0 before the handoff and 1 after it, and rises in between', () => {
    expect(handoffOpacity(0, 0.2)).toBe(0)
    expect(handoffOpacity(1, 0.2)).toBe(1)
    let last = 0
    for (let h = 0.1; h < 1; h += 0.1) {
      const value = handoffOpacity(h, 0.2)
      expect(value).toBeGreaterThan(last)
      last = value
    }
  })

  it('a fully opaque wash simply switches layers', () => {
    expect(handoffOpacity(0.01, 1)).toBe(1)
  })
})

describe('washUnderFactor', () => {
  it('is the whole wash at emergence 0 and washUnder of it at 1', () => {
    expect(washUnderFactor(0, 0.3)).toBe(1)
    expect(washUnderFactor(1, 0.3)).toBeCloseTo(0.3)
    expect(washUnderFactor(0.5, 0)).toBeCloseTo(0.5)
    expect(washUnderFactor(1, 1)).toBe(1)
  })
})
