import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { createStrokeRenderer } from './strokeRenderer'
import { createTraceModel, MAX_INSTANCES, TRACE_KNOBS } from './traceModel'

/**
 * **Trace** on the WebGL2 tier — W23-7, ported by W23-16. The ribbon and its
 * afterimages are `traceModel.ts`; each is one instance of the shared stroke
 * renderer's open `ribbon` layout (`strokeRenderer.ts`), all in one draw.
 * `overlay`, so the host fades it in over the wash.
 */

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Trace draws on a WebGL2 surface')
  const gl = target.context
  const model = createTraceModel(target.quality, target.params)
  const renderer = createStrokeRenderer(
    gl,
    'Trace',
    'ribbon',
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

/** W23-7: the waveform as a drifting ribbon with afterimages. */
export const TRACE: VisualizerEffect = {
  id: 'trace',
  label: 'Trace',
  surface: 'webgl2',
  emergence: 'overlay',
  params: TRACE_KNOBS,
  create
}
