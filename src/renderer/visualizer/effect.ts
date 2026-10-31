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
 *
 * The wash is not the effect's to draw unless it is a `grow` effect: the host
 * keeps it on a canvas of its own under an `overlay` effect's.
 */

export type VisualizerSurface = '2d' | 'webgl2'

/**
 * The rendered wash, for `grow` effects (D35.12): the stage's blurred cover
 * exactly as it should appear — fitted, scaled, blurred, saturated and at the
 * wash opacity, on a transparent canvas the size of the effect's own. A `grow`
 * effect draws it as is at emergence 0 and so *is* the wash there; it is
 * transparent when the track has no cover. On the 2D tier it is the host's wash
 * canvas; the WebGL2 tier's texture arrives with W23-8, and until then this is
 * null on that surface.
 */
export interface WashInput {
  readonly source: CanvasImageSource | WebGLTexture
  /**
   * `--stage-wash-scale`, the wash's `scale()` about the centre. A `grow`
   * effect that lays the sharp cover over the wash fits it object-cover at
   * this scale, so the two line up as the blur resolves (W23-7, Mosaic).
   */
  readonly scale: number
}

export interface StageInputs {
  /**
   * 0 = the wash, 1 = the effect (D35.12). `overlay` effects may ignore it: the
   * host fades their canvas in over the wash by it. `grow` effects must equal
   * `wash` at 0 and scale their motion up from there.
   */
  readonly emergence: number
  /** The flash guard's multiplier (D35.8). Every effect multiplies it into its output. */
  readonly intensity: number
  /** The wash on the 2D tier; null on WebGL2 until W23-8. */
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
  /**
   * D35.12; `overlay` only, 0..1, default 1: how much of the wash stays under
   * the effect at full emergence.
   */
  readonly washUnder?: number
  create(target: EffectTarget): EffectInstance
}
