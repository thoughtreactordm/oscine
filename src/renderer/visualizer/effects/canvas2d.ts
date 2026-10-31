import type { VisualizerQuality } from '@shared/settings'
import type { AnalysisFrame } from '../analysisFrame'
import type { EffectInstance, EffectTarget, StageInputs } from '../effect'
import type { Palette } from '../palette'
import type { Cover2D, Draw2D, Effect2DInstance, Stage2D } from './draw2d'

/**
 * The DOM half of the W23-7 effects: hands a DOM-free effect core
 * (`draw2d.ts`) the real 2D context and narrows `StageInputs` to what it draws.
 * Kept this thin because the cores are what the tests cover.
 */

type Image2D = CanvasImageSource

export type Effect2DCore = (
  ctx: Draw2D<Image2D>,
  quality: VisualizerQuality
) => Effect2DInstance<Image2D, AnalysisFrame, Palette>

interface MutableStage2D {
  emergence: number
  intensity: number
  wash: { source: Image2D } | null
  cover: Cover2D<Image2D> | null
}

function isTexture(source: CanvasImageSource | WebGLTexture): source is WebGLTexture {
  return typeof WebGLTexture !== 'undefined' && source instanceof WebGLTexture
}

/** `VisualizerEffect.create` for a 2D core. The adapted stage is one object, reused every frame. */
export function create2D(
  core: Effect2DCore,
  label: string
): (target: EffectTarget) => EffectInstance {
  return (target) => {
    if (target.surface !== '2d') throw new Error(`${label} draws on a 2D surface`)
    const inner = core(target.context, target.quality)
    /** Made the first time the host hands over a 2D wash, then updated in place. */
    let wash: { source: Image2D } | null = null
    const stage2d: MutableStage2D = { emergence: 0, intensity: 1, wash: null, cover: null }
    const view: Stage2D<Image2D> = stage2d
    return {
      resize: (width, height) => inner.resize(width, height),
      frame(audio: AnalysisFrame, palette: Palette, stage: StageInputs, dtSec: number): void {
        stage2d.emergence = stage.emergence
        stage2d.intensity = stage.intensity
        stage2d.cover = stage.cover
        const input = stage.wash
        if (input && !isTexture(input.source)) {
          if (wash) {
            wash.source = input.source
          } else {
            wash = { source: input.source }
          }
          stage2d.wash = wash
        } else {
          stage2d.wash = null
        }
        inner.frame(audio, palette, view, dtSec)
      },
      dispose: () => inner.dispose()
    }
  }
}
