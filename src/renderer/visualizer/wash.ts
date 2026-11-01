/**
 * The arithmetic of the host-drawn wash — **W23-5, D35.12**.
 *
 * The stage's CSS wash is the cover as `.stage-wash-img` draws it: object-cover
 * into the stage box, `blur(--stage-wash-blur) saturate(--stage-wash-saturate)`,
 * `opacity: --stage-wash-opacity`, `scale(--stage-wash-scale)`. The 2D wash pass
 * (`washPass.ts`) reproduces it, and this module is everything in that pass that
 * is a number rather than a canvas call: reading the four properties, sizing
 * the small blur canvas, the object-cover crop, the scale's destination rect,
 * the cover crossfade's alphas, and the opacity that lets the canvas and the
 * `<img>` cross-fade without the pair ever reading heavier than one wash.
 *
 * Pure and DOM-free, so Vitest covers it.
 */

/** The four registered properties `.stage-wash-img` consumes and the host reads. */
export const WASH_BLUR_PROPERTY = '--stage-wash-blur'
export const WASH_SATURATE_PROPERTY = '--stage-wash-saturate'
export const WASH_OPACITY_PROPERTY = '--stage-wash-opacity'
export const WASH_SCALE_PROPERTY = '--stage-wash-scale'
/** The motion token every D35.12 duration is a multiple of. */
export const MOTION_DURATION_PROPERTY = '--oscine-motion-duration'

export interface WashLook {
  /** The Gaussian σ in CSS pixels (CSS `blur(r)` is σ = r), before the scale. */
  readonly blurPx: number
  /** The `saturate()` amount. */
  readonly saturate: number
  /** The wash's opacity, 0..1. */
  readonly opacity: number
  /** The `scale()` about the centre. */
  readonly scale: number
}

/**
 * The look from the computed values of the four properties. They are
 * registered with `@property`, so a computed value is a resolved `64px` or
 * `0.198`, never the `calc(…)` that wrote it. Null when any of them is not a
 * finite number — the properties are missing from the cascade, which is a bug
 * worth not drawing a wrong wash over.
 */
export function parseWashLook(read: (property: string) => string): WashLook | null {
  const blurPx = Number.parseFloat(read(WASH_BLUR_PROPERTY))
  const saturate = Number.parseFloat(read(WASH_SATURATE_PROPERTY))
  const opacity = Number.parseFloat(read(WASH_OPACITY_PROPERTY))
  const scale = Number.parseFloat(read(WASH_SCALE_PROPERTY))
  if (![blurPx, saturate, opacity, scale].every(Number.isFinite)) return null
  return {
    blurPx: blurPx > 0 ? blurPx : 0,
    saturate: saturate > 0 ? saturate : 0,
    // `opacity` clamps; the canvas must clamp the same way to match.
    opacity: opacity < 0 ? 0 : opacity > 1 ? 1 : opacity,
    scale: scale > 0 ? scale : 1
  }
}

/** A CSS `<time>` (`150ms`, `0.2s`) in seconds, or null when it is not one. */
export function parseCssDurationSec(text: string): number | null {
  const match = /^\s*(-?\d*\.?\d+(?:e[+-]?\d+)?)\s*(ms|s)\s*$/i.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0) return null
  return match[2].toLowerCase() === 'ms' ? value / 1000 : value
}

/**
 * σ in the small canvas's pixels. `ctx.filter` blur is only cheap on a small
 * canvas, so the cover is drawn at 1/`factor` of the stage, where σ = 64 px
 * becomes 8 — the same ⅛ the GPU pass (W23-8) downsamples to.
 */
export const WASH_TARGET_SIGMA = 8
/** The small canvas's longest edge never exceeds this, whatever the blur. */
export const WASH_MAX_EDGE = 512

export interface WashGeometry {
  /** The small canvas, in its own pixels. */
  readonly width: number
  readonly height: number
  /** The stage-box pixels per small-canvas pixel. */
  readonly factor: number
  /** σ to give `ctx.filter` on the small canvas. */
  readonly blurPx: number
}

/** The small canvas the cover is blurred on, for a stage box in CSS pixels. */
export function washGeometry(boxWidth: number, boxHeight: number, blurPx: number): WashGeometry {
  const longest = boxWidth > boxHeight ? boxWidth : boxHeight
  const factor = Math.max(1, blurPx / WASH_TARGET_SIGMA, longest / WASH_MAX_EDGE)
  return {
    width: Math.max(1, Math.ceil(boxWidth / factor)),
    height: Math.max(1, Math.ceil(boxHeight / factor)),
    factor,
    blurPx: blurPx / factor
  }
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * The source rectangle `object-fit: cover` (centred, the default
 * `object-position`) shows of a `sourceWidth`×`sourceHeight` image in a box of
 * the given size.
 */
export function objectCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number
): Rect {
  if (sourceWidth <= 0 || sourceHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { x: 0, y: 0, width: Math.max(0, sourceWidth), height: Math.max(0, sourceHeight) }
  }
  const scale = Math.max(boxWidth / sourceWidth, boxHeight / sourceHeight)
  const width = boxWidth / scale
  const height = boxHeight / scale
  return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height }
}

/** Where a box-sized layer lands under `scale(s)` about its centre. */
export function scaledRect(width: number, height: number, scale: number): Rect {
  const scaledWidth = width * scale
  const scaledHeight = height * scale
  return {
    x: (width - scaledWidth) / 2,
    y: (height - scaledHeight) / 2,
    width: scaledWidth,
    height: scaledHeight
  }
}

/**
 * The two `globalAlpha`s for drawing a cover crossfade into the wash: the
 * previous cover first, then the current with `'lighter'`. Adding the two
 * premultiplied layers at `(1 - mix)` and `mix` of the wash opacity is an exact
 * lerp between the two washes, with coverage the wash opacity throughout.
 */
export function crossfadeAlphas(
  mix: number,
  opacity: number
): { readonly previous: number; readonly current: number } {
  const m = mix < 0 ? 0 : mix > 1 ? 1 : mix
  return { previous: (1 - m) * opacity, current: m * opacity }
}

/**
 * The CSS opacity for the canvas wash during the handoff, so that it and the
 * `<img>` stacked under it always cover the stage exactly as one wash does.
 *
 * The canvas carries the wash with its opacity `w` already baked in; the
 * `<img>`'s opacity runs linearly from `w` to 0 as `handoff` runs 0 → 1 (the
 * 150 ms linear transition `StageView` runs). Two layers of the same colour at
 * `a` and `b` cover `a + b(1 − a)`; holding that at `w` with `a = w(1 − h)` gives
 * the canvas `b = w·h / (1 − w + w·h)`, i.e. a CSS opacity of `h / (1 − w + w·h)`.
 * At h = 0 the canvas is invisible, at h = 1 it is fully shown.
 */
export function handoffOpacity(handoff: number, washOpacity: number): number {
  const h = handoff < 0 ? 0 : handoff > 1 ? 1 : handoff
  if (h === 0) return 0
  if (h === 1) return 1
  const w = washOpacity < 0 ? 0 : washOpacity > 1 ? 1 : washOpacity
  return h / (1 - w + w * h)
}

/**
 * How much of the wash stays under an `overlay` effect at the given emergence
 * (D35.12): all of it at the wash, `washUnder` of it at full emergence.
 */
export function washUnderFactor(emergence: number, washUnder: number): number {
  const under = washUnder < 0 ? 0 : washUnder > 1 ? 1 : washUnder
  return 1 - emergence * (1 - under)
}
