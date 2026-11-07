import { describe, expect, it } from 'vitest'
import { canvasKey, parseRasterOverride, rasterFor } from '../../../src/renderer/visualizer/raster'

/**
 * Where a 2D effect canvas rasterises, and the key that keeps a canvas from
 * being reused across rasters (its context attributes stick to the element).
 */

const GPU_2D = { surface: '2d', raster: undefined } as const
const CPU_2D = { surface: '2d', raster: 'cpu' } as const
const WEBGL = { surface: 'webgl2', raster: undefined } as const

describe('parseRasterOverride', () => {
  it('reads cpu and gpu, in any case and padding', () => {
    expect(parseRasterOverride('cpu')).toBe('cpu')
    expect(parseRasterOverride(' GPU ')).toBe('gpu')
  })

  it('is no override for anything else', () => {
    for (const raw of [undefined, null, '', 'software', '1', 1, true]) {
      expect(parseRasterOverride(raw)).toBeNull()
    }
  })
})

describe('rasterFor', () => {
  it("defaults a 2D effect to the GPU and honours an effect's own choice", () => {
    expect(rasterFor(GPU_2D, null)).toBe('gpu')
    expect(rasterFor(CPU_2D, null)).toBe('cpu')
  })

  it('lets the override win either way', () => {
    expect(rasterFor(GPU_2D, 'cpu')).toBe('cpu')
    expect(rasterFor(CPU_2D, 'gpu')).toBe('gpu')
  })

  it('has nothing to say about WebGL or no effect', () => {
    expect(rasterFor(WEBGL, 'cpu')).toBeNull()
    expect(rasterFor(null, 'cpu')).toBeNull()
  })
})

describe('canvasKey', () => {
  it('separates the two 2D rasters from each other and from WebGL', () => {
    const keys = new Set([canvasKey(GPU_2D, null), canvasKey(CPU_2D, null), canvasKey(WEBGL, null)])
    expect(keys.size).toBe(3)
  })

  it('keys no effect as the GPU 2D canvas the host starts with', () => {
    expect(canvasKey(null, null)).toBe(canvasKey(GPU_2D, null))
  })

  it('follows the override, so a forced raster never reuses the other canvas', () => {
    expect(canvasKey(CPU_2D, 'gpu')).toBe(canvasKey(GPU_2D, null))
    expect(canvasKey(GPU_2D, 'cpu')).toBe(canvasKey(CPU_2D, null))
  })
})
