import type { VisualizerEffect } from './effect'
import { BARS } from './effects/bars'
import { create2D } from './effects/canvas2d'
import { createHalo } from './effects/halo'
import { createMosaic } from './effects/mosaic'
import { createTrace } from './effects/trace'

/** W23-7: a radial spectrum ringing a disc of the cover. */
const HALO: VisualizerEffect = {
  id: 'halo',
  label: 'Halo',
  surface: '2d',
  needs: { cover: true },
  emergence: 'overlay',
  create: create2D(createHalo, 'Halo')
}

/** W23-7: the waveform as a drifting ribbon with afterimages. */
const TRACE: VisualizerEffect = {
  id: 'trace',
  label: 'Trace',
  surface: '2d',
  emergence: 'overlay',
  create: create2D(createTrace, 'Trace')
}

/** W23-7: the cover in tiles that lift on their bands; the first `grow` effect. */
const MOSAIC: VisualizerEffect = {
  id: 'mosaic',
  label: 'Mosaic',
  surface: '2d',
  needs: { cover: true },
  emergence: 'grow',
  create: create2D(createMosaic, 'Mosaic')
}

/**
 * The stage's effects, in display order — **D35.1**.
 *
 * A static array: no runtime plugin loading and no operator-authored shaders or
 * scripts (that would be a script-execution surface in the renderer, and needs
 * a decision of its own). The first entry is the default and must be 2D, so the
 * visualizer always has something to show without a GPU (D35.6) — its `id` is
 * `DEFAULT_VISUALIZER_EFFECT` from the shared settings for the same reason.
 */
export const VISUALIZER_EFFECTS: readonly VisualizerEffect[] = [BARS, HALO, TRACE, MOSAIC]

/**
 * The effects that can run this session. Everything until the WebGL2 tier
 * (D35.6) lands; then a failed capability probe or shader removes entries here,
 * and next/previous, the cycle and the palette all read this, not the array.
 */
export function availableEffects(): readonly VisualizerEffect[] {
  return VISUALIZER_EFFECTS
}
