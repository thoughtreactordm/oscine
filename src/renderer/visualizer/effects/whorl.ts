import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { createStrokeRenderer } from './strokeRenderer'
import { createWhorlModel, MAX_INSTANCES, WHORL_KNOBS } from './whorlModel'

/**
 * **Whorl** on the WebGL2 tier — W23-7, ported by W23-16. The tunnel is
 * `whorlModel.ts`; every ring is one instance of the shared stroke renderer's
 * closed `ring` layout (`strokeRenderer.ts`), all in one draw. `overlay`, so
 * the host fades it in over the wash.
 */

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Whorl draws on a WebGL2 surface')
  const gl = target.context
  const model = createWhorlModel(target.quality, target.params)
  const renderer = createStrokeRenderer(
    gl,
    'Whorl',
    'ring',
    model.points,
    model.rows,
    MAX_INSTANCES
  )
  let width = 1
  let height = 1

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
    },

    frame(audio, palette, stage, dtSec) {
      model.update(audio, stage.intensity, width, height, dtSec)
      renderer.draw(model, palette, width, height)
    },

    dispose() {
      renderer.dispose()
    }
  }
}

/** W23-7: the waveform as a ring, its afterimages spiralling outward. */
export const WHORL: VisualizerEffect = {
  id: 'whorl',
  label: 'Whorl',
  surface: 'webgl2',
  emergence: 'overlay',
  params: WHORL_KNOBS,
  create
}
