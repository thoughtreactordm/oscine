import type { VisualizerEffect } from './effect'

/**
 * Where a 2D effect canvas rasterises.
 *
 * `'gpu'` is Chromium's default accelerated canvas. `'cpu'` creates the
 * context with `willReadFrequently: true`, which is how a page asks Chromium
 * for a software-backed canvas: paths are scan-converted straight into the
 * backing store and the compositor uploads the finished frame once. On Windows
 * (ANGLE over D3D11, no MSAA) the accelerated canvas instead draws each
 * anti-aliased path through a software mask the size of its bounds, uploaded
 * per draw — cheap for a few bars, ruinous for Whorl's tunnel of rings.
 *
 * It also makes the host's 2D luminance sample (D35.8) a CPU downscale: from an
 * accelerated canvas, `drawImage` into the `willReadFrequently` probe forces a
 * synchronous readback of the whole stage.
 */
export type Raster2D = 'cpu' | 'gpu'

/**
 * `VITE_VISUALIZER_RASTER`, parsed: `cpu` or `gpu` forces every 2D effect that
 * way, for an A/B on one machine; anything else is no override.
 */
export function parseRasterOverride(raw: unknown): Raster2D | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toLowerCase()
  return value === 'cpu' || value === 'gpu' ? value : null
}

/** The raster an effect's canvas gets, or null for a WebGL effect (or none at all). */
export function rasterFor(
  effect: Pick<VisualizerEffect, 'surface' | 'raster'> | null,
  override: Raster2D | null
): Raster2D | null {
  if (!effect || effect.surface !== '2d') return null
  return override ?? effect.raster ?? 'gpu'
}

/**
 * The effect canvas's key. A canvas keeps the context type *and* the context
 * attributes it was first asked for, so a switch between rasters needs a new
 * element exactly as a switch between surfaces does. No effect keys as 2D on
 * the GPU, the canvas the host starts with.
 */
export function canvasKey(
  effect: Pick<VisualizerEffect, 'surface' | 'raster'> | null,
  override: Raster2D | null
): string {
  if (effect?.surface === 'webgl2') return 'webgl2'
  return `2d-${rasterFor(effect, override) ?? 'gpu'}`
}
