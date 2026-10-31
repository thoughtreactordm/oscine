import type { VisualizerQuality } from '@shared/settings'
import type { AnalysisFrame } from './analysisFrame'
import type { StageCoverInput } from './coverDecode'
import type { Palette } from './palette'

/**
 * The contract between the stage host and an effect — **D35.1**.
 *
 * An effect is a plain module that draws and holds nothing else. The host
 * (`panels/VisualizerStage.vue`) owns everything with a lifecycle: the canvas,
 * the loop, the analysis frame, the palette, the flash guard, the cover and the
 * wash. Effects never upload, decode or delete the cover or the wash.
 *
 * Effects are frame-rate independent — all motion comes from `dtSec` (already
 * clamped to 0.1 s) and the analysis frame, never a frame count — and allocate
 * nothing per frame. Every colour they draw is a function of palette entries
 * (D35.3), and every output is multiplied by `stage.intensity` (D35.8).
 */

export type VisualizerSurface = '2d' | 'webgl2'

/**
 * The rendered wash, for `grow` effects (D35.12). The host does not draw a wash
 * of its own until W23-5; until then the CSS wash sits under an `overlay`
 * canvas and this is always null.
 */
export interface WashInput {
  readonly source: CanvasImageSource | WebGLTexture
}

export interface StageInputs {
  /** 0 = the wash, 1 = the effect (D35.12). Overlay effects may ignore it; the host applies it. */
  readonly emergence: number
  /** The flash guard's multiplier (D35.8). Every effect multiplies it into its output. */
  readonly intensity: number
  /** Null until W23-5. */
  readonly wash: WashInput | null
  /** Null unless the effect declares `needs.cover` (D35.11). */
  readonly cover: StageCoverInput | null
}

export type EffectTarget =
  | {
      readonly surface: '2d'
      readonly context: CanvasRenderingContext2D
      readonly quality: VisualizerQuality
    }
  | {
      readonly surface: 'webgl2'
      readonly context: WebGL2RenderingContext
      readonly quality: VisualizerQuality
    }

export interface EffectInstance {
  /** Backing-store pixels. Called once before the first frame and on every resize. */
  resize(width: number, height: number): void
  frame(audio: AnalysisFrame, palette: Palette, stage: StageInputs, dtSec: number): void
  dispose(): void
}

export interface VisualizerEffect {
  /** Stable; persisted in `interface.visualizerEffect`. */
  readonly id: string
  /** Shown on switch and in the palette. */
  readonly label: string
  readonly surface: VisualizerSurface
  readonly needs?: { readonly cover?: boolean; readonly stereo?: boolean }
  /** D35.12. */
  readonly emergence: 'overlay' | 'grow'
  /** D35.12; overlay only, 0..1, default 1. */
  readonly washUnder?: number
  create(target: EffectTarget): EffectInstance
}
