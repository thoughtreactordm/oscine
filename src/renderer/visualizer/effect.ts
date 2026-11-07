import type { VisualizerQuality } from '@shared/settings'
import type { AnalysisFrame } from './analysisFrame'
import type { StageCoverInput } from './coverDecode'
import type { Palette } from './palette'
import type { EffectParamSpec, EffectParams } from './params'
import type { Raster2D } from './raster'
import type { WashLook } from './wash'

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
 * canvas. On the WebGL2 tier it is a texture in the effect's own context
 * (`gl/washPass.ts`): premultiplied, at the wash opacity, y-up, so a
 * full-screen triangle samples it with its screen UVs as is. It is only
 * composed for `grow` effects; an `overlay` effect gets null on WebGL2.
 */
export interface WashInput {
  readonly source: CanvasImageSource | WebGLTexture
  /**
   * The look the wash was drawn with (W23-10), for a `grow` effect that draws
   * the cover itself and must match it: Plumage saturates its cover layer with
   * the wash's matrix and starts from its opacity and scale. Null until the
   * host has read the stage's properties.
   */
  readonly look: WashLook | null
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
  /** The wash; on WebGL2 only for `grow` effects. */
  readonly wash: WashInput | null
  /** Null unless the effect declares `needs.cover` (D35.11). */
  readonly cover: StageCoverInput | null
}

/**
 * On WebGL2 the host binds the default framebuffer, sets the viewport to the
 * internal target (D35.6's budget — the canvas backing store, which the
 * compositor scales up to the box) and leaves blending off before every
 * `frame`; an effect sets whatever else it needs. Its `resize` gets that
 * internal size, not the box's.
 *
 * `params` holds the effect's knob values (`params.ts`), one per declared
 * `params` spec. The host writes changes into this same object, so an effect
 * keeps the reference and reads it every frame; it never copies a knob out at
 * create time.
 */
export type EffectTarget =
  | {
      readonly surface: '2d'
      readonly context: CanvasRenderingContext2D
      readonly quality: VisualizerQuality
      readonly params: EffectParams
    }
  | {
      readonly surface: 'webgl2'
      readonly context: WebGL2RenderingContext
      readonly quality: VisualizerQuality
      readonly params: EffectParams
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
  /**
   * `2d` only, default `'gpu'`: where the effect canvas rasterises (`raster.ts`).
   * `'cpu'` is for path-heavy effects — Chromium's accelerated canvas on Windows
   * draws each anti-aliased path through a mask the size of its bounds, which a
   * tunnel of near-full-stage rings cannot afford.
   */
  readonly raster?: Raster2D
  /** The knobs the stage's tuning popover offers, in display order. None: no popover. */
  readonly params?: readonly EffectParamSpec[]
  create(target: EffectTarget): EffectInstance
}
