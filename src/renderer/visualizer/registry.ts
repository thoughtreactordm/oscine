import type { VisualizerEffect } from './effect'
import { BARS } from './effects/bars'
import { create2D } from './effects/canvas2d'
import { createGyre } from './effects/gyre'
import { createHalo } from './effects/halo'
import { createSilk } from './effects/silk'
import { createTrace } from './effects/trace'
import { createUpdraft } from './effects/updraft'
import { createWhorl } from './effects/whorl'

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

/** W23-7: the waveform as a ring, its afterimages spiralling outward. */
const WHORL: VisualizerEffect = {
  id: 'whorl',
  label: 'Whorl',
  surface: '2d',
  emergence: 'overlay',
  create: create2D(createWhorl, 'Whorl')
}

/** W23-7: pendulum-pen threads whose rates drift with the band energies. */
const SILK: VisualizerEffect = {
  id: 'silk',
  label: 'Silk',
  surface: '2d',
  emergence: 'overlay',
  create: create2D(createSilk, 'Silk')
}

/** W23-7: motes on a swirling flow field, trailing smoke. */
const UPDRAFT: VisualizerEffect = {
  id: 'updraft',
  label: 'Updraft',
  surface: '2d',
  emergence: 'overlay',
  create: create2D(createUpdraft, 'Updraft')
}

/** W23-7: the spectrum as arcs orbiting on concentric rings. */
const GYRE: VisualizerEffect = {
  id: 'gyre',
  label: 'Gyre',
  surface: '2d',
  emergence: 'overlay',
  create: create2D(createGyre, 'Gyre')
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
export const VISUALIZER_EFFECTS: readonly VisualizerEffect[] = [
  BARS,
  HALO,
  GYRE,
  TRACE,
  WHORL,
  SILK,
  UPDRAFT
]

/**
 * The effects that can run this session. Everything until the WebGL2 tier
 * (D35.6) lands; then a failed capability probe or shader removes entries here,
 * and next/previous, the cycle and the palette all read this, not the array.
 */
export function availableEffects(): readonly VisualizerEffect[] {
  return VISUALIZER_EFFECTS
}
