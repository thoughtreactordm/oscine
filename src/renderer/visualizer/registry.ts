import type { VisualizerEffect } from './effect'
import { BARS } from './effects/bars'
import { create2D } from './effects/canvas2d'
import { createGyre, GYRE_KNOBS } from './effects/gyre'
import { createHalo, HALO_KNOBS } from './effects/halo'
import { createSilk, SILK_KNOBS } from './effects/silk'
import { TRACE } from './effects/trace'
import { UPDRAFT } from './effects/updraft'
import { WHORL } from './effects/whorl'
import { DRIFT } from './effects/drift'
import { PLUMAGE } from './effects/plumage'
import { RAINFALL } from './effects/rainfall'
import { GROOVE } from './effects/groove'
import { MURMURATION } from './effects/murmuration'
import { GL_WASH_TEST } from './effects/glWashTest'
import { availableOf } from './glSession'

/** W23-7: a radial spectrum ringing a disc of the cover. */
const HALO: VisualizerEffect = {
  id: 'halo',
  label: 'Halo',
  surface: '2d',
  needs: { cover: true },
  emergence: 'overlay',
  params: HALO_KNOBS,
  create: create2D(createHalo, 'Halo')
}

/** W23-7: pendulum-pen threads whose rates drift with the band energies. */
const SILK: VisualizerEffect = {
  id: 'silk',
  label: 'Silk',
  surface: '2d',
  emergence: 'overlay',
  params: SILK_KNOBS,
  create: create2D(createSilk, 'Silk')
}

/** W23-7: the spectrum as arcs orbiting on concentric rings. */
const GYRE: VisualizerEffect = {
  id: 'gyre',
  label: 'Gyre',
  surface: '2d',
  emergence: 'overlay',
  params: GYRE_KNOBS,
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
  UPDRAFT,
  DRIFT,
  PLUMAGE,
  RAINFALL,
  GROOVE,
  MURMURATION,
  // W23-8's tier check, dev builds only (`effects/glWashTest.ts`).
  ...(import.meta.env.DEV && import.meta.env.VITE_VISUALIZER_GL_TEST === '1' ? [GL_WASH_TEST] : [])
]

/**
 * The effects that can run this session (D35.6): the registry less what the
 * WebGL2 tier has ruled out — every WebGL effect when the capability probe
 * fails, the context is lost (until restored) or has been lost twice, and any
 * one effect whose shaders failed. Next/previous, the cycle and the palette all
 * read this, not the array, and reading it in a `computed` tracks the tier.
 * The probe runs on the first ask, and only if a WebGL effect is registered.
 */
export function availableEffects(): readonly VisualizerEffect[] {
  return availableOf(VISUALIZER_EFFECTS)
}
