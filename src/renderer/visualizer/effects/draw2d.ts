import type { CoverBitmap, CoverInput, CoverSlot } from '../cover'

/**
 * The structural 2D surface the W23-7 effects draw on — **D35.1**.
 *
 * `tests/` compile under `tsconfig.node.json`, which has no DOM lib, so a module
 * a test imports cannot name `CanvasRenderingContext2D`, `ImageBitmap` or
 * `OffscreenCanvas` (the trap `cover.ts` already works around). The effect
 * cores are therefore written against the few members they use, generic over
 * the image type `I` they draw; `registry.ts` instantiates them with the real
 * context, where `I` is `CanvasImageSource`, and the tests with a recording
 * stub.
 *
 * Only what the cores call is here. Adding a member is fine; it must keep
 * `CanvasRenderingContext2D` `OffscreenCanvasRenderingContext2D`
 * assignable, which method syntax (bivariant parameters) keeps easy.
 */

export interface Draw2D<I> {
  globalAlpha: number
  globalCompositeOperation: string
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  lineCap: string
  lineJoin: string
  imageSmoothingEnabled: boolean

  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, width: number, height: number): void
  fillRect(x: number, y: number, width: number, height: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  closePath(): void
  stroke(): void
  fill(): void
  clip(): void
  drawImage(
    image: I,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number
  ): void
}

/** The stage's cover input, generic over the bitmap a 2D effect draws. */
export type Cover2D<I> = CoverInput<CoverSlot<I & CoverBitmap, unknown>>

/**
 * `StageInputs` as a 2D effect core sees it. The wash is narrowed to something
 * `drawImage` takes (on the 2D tier it is the host's wash canvas) and carries
 * the wash's scale, so a `grow` effect can fit the cover exactly as the wash is
 * fitted.
 */
export interface Stage2D<I> {
  readonly emergence: number
  readonly intensity: number
  readonly wash: { readonly source: I; readonly scale: number } | null
  readonly cover: Cover2D<I> | null
}

export type Quality2D = 'auto' | 'low' | 'high'

export interface Effect2DInstance<I, Audio, Colours> {
  resize(width: number, height: number): void
  frame(audio: Audio, palette: Colours, stage: Stage2D<I>, dtSec: number): void
  dispose(): void
}

/** `1 - e^(-dt/τ)`: how far an exponential follower moves in `dtSec`. */
export function follow(dtSec: number, tauSec: number): number {
  if (!(dtSec > 0)) return 0
  return 1 - Math.exp(-dtSec / tauSec)
}

/** Where a cover lands when fitted: source pixel `(u, v)` draws at `(x + u·k, y + v·k)`. */
export interface CoverFit {
  k: number
  x: number
  y: number
}

/** A fit to fill in place, made once per effect. */
export function createCoverFit(): CoverFit {
  return { k: 0, x: 0, y: 0 }
}

/**
 * Fit a `sourceWidth`×`sourceHeight` bitmap object-cover into the box
 * `(boxX, boxY, boxW, boxH)`, scaled about the box's centre by `scale` —
 * `.stage-wash-img`'s fit, without the blur. Writes into `out`; returns false
 * (leaving `out` alone) when either size is empty.
 */
export function fitCover(
  out: CoverFit,
  sourceWidth: number,
  sourceHeight: number,
  boxX: number,
  boxY: number,
  boxW: number,
  boxH: number,
  scale: number
): boolean {
  if (!(sourceWidth > 0 && sourceHeight > 0 && boxW > 0 && boxH > 0)) return false
  const k = Math.max(boxW / sourceWidth, boxH / sourceHeight) * scale
  out.k = k
  out.x = boxX + (boxW - sourceWidth * k) / 2
  out.y = boxY + (boxH - sourceHeight * k) / 2
  return true
}

/**
 * Draw the part of a fitted bitmap that lands on the destination rect
 * `(dx, dy, dw, dh)` — in fit space — at `(px, py, dw, dh)` on the context.
 * One `drawImage`, no allocation.
 */
export function drawFittedRegion<I>(
  ctx: Draw2D<I>,
  bitmap: I,
  fit: CoverFit,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  px: number,
  py: number
): void {
  const k = fit.k
  ctx.drawImage(bitmap, (dx - fit.x) / k, (dy - fit.y) / k, dw / k, dh / k, px, py, dw, dh)
}
