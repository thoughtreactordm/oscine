import type { StageCoverInput } from './coverDecode'
import { crossfadeAlphas, objectCoverCrop, scaledRect, washGeometry, type WashLook } from './wash'

/**
 * The 2D wash pass — **W23-5, D35.12**.
 *
 * Reproduces `.stage-wash-img` on the host's wash canvas. Per cover, the cover
 * is drawn object-cover into a small offscreen canvas with `ctx.filter` blur
 * and saturate scaled to that canvas (σ ≈ 8 px there), which is the only place
 * `ctx.filter` is cheap. Composing then upscales that with smoothing into the
 * stage-sized canvas under the scale, at the wash opacity, onto a transparent
 * canvas — so it composites over the stage exactly as the `<img>` does without
 * knowing what is underneath.
 *
 * The blur sees the small canvas's edges as transparent, just as a CSS filter
 * sees the `<img>`'s box, so the faded rim matches too; the scale pushes most
 * of it out of the stage either way.
 *
 * Composing happens only when something it depends on changes — the cover
 * slots, the crossfade's mix, the look, the size — so a settled wash costs
 * nothing per frame and a track change costs two `drawImage`s per frame for
 * the crossfade's ~600 ms.
 *
 * Matched within tolerance, not bit-exact: the blur kernels differ. W23-15
 * checks it by screenshot.
 */

/** What a cover slot draws as wash: its bitmap, or nothing at all. */
export type WashImage = ImageBitmap | null

export interface WashPass {
  /** The stage box in CSS pixels and the backing-store ratio. Returns whether anything changed. */
  resize(cssWidth: number, cssHeight: number, ratio: number): boolean
  /** The four properties, read on mount and on theme change. */
  setLook(look: WashLook): void
  /**
   * Draw the wash for this cover state if it differs from what is drawn.
   * `image` maps a slot to what it shows as wash — a synthetic stand-in shows
   * nothing, unless the URL is the library's placeholder (which the CSS wash
   * does show). `cut` ignores a fade *from* a slot that draws nothing, so the
   * first decode lands whole instead of fading in under the handoff.
   */
  compose(
    input: StageCoverInput | null,
    image: (slot: StageCoverInput['current']) => WashImage,
    cut: boolean
  ): void
  /** True once something drawable has been composed for the current state. */
  readonly drawn: boolean
  /** Drop the cached small canvases (on dispose). */
  dispose(): void
}

export function createWashPass(canvas: HTMLCanvasElement): WashPass {
  const context = canvas.getContext('2d')
  const smalls = new Map<ImageBitmap, OffscreenCanvas>()
  let look: WashLook | null = null
  let cssWidth = 0
  let cssHeight = 0
  let ratio = 1
  /** Bumped when the look or the size changes, so the cached smalls are stale. */
  let version = 0
  let smallsVersion = -1

  let lastVersion = -1
  let lastCurrent: WashImage | undefined
  let lastPrevious: WashImage | undefined
  let lastMix = -1
  let drawn = false

  function renderSmall(bitmap: ImageBitmap): OffscreenCanvas | null {
    if (!look || cssWidth <= 0 || cssHeight <= 0) return null
    if (smallsVersion !== version) {
      smalls.clear()
      smallsVersion = version
    }
    const cached = smalls.get(bitmap)
    if (cached) return cached
    const geometry = washGeometry(cssWidth, cssHeight, look.blurPx)
    const small = new OffscreenCanvas(geometry.width, geometry.height)
    const smallContext = small.getContext('2d')
    if (!smallContext) return null
    const crop = objectCoverCrop(bitmap.width, bitmap.height, geometry.width, geometry.height)
    smallContext.imageSmoothingEnabled = true
    smallContext.imageSmoothingQuality = 'high'
    // Blur, then saturate: the order `.stage-wash-img` writes them.
    smallContext.filter = `blur(${geometry.blurPx}px) saturate(${look.saturate})`
    smallContext.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      geometry.width,
      geometry.height
    )
    smalls.set(bitmap, small)
    return small
  }

  function drawLayer(image: WashImage, alpha: number): boolean {
    if (!context || !image || alpha <= 0 || !look) return false
    const small = renderSmall(image)
    if (!small) return false
    const target = scaledRect(cssWidth * ratio, cssHeight * ratio, look.scale)
    context.globalAlpha = alpha
    context.drawImage(small, target.x, target.y, target.width, target.height)
    return true
  }

  /** Forget smalls for bitmaps no longer on screen; closed bitmaps are never drawn again. */
  function prune(current: WashImage, previous: WashImage): void {
    for (const bitmap of smalls.keys()) {
      if (bitmap !== current && bitmap !== previous) smalls.delete(bitmap)
    }
  }

  return {
    get drawn() {
      return drawn
    },

    resize(nextWidth, nextHeight, nextRatio) {
      const width = Math.round(nextWidth * nextRatio)
      const height = Math.round(nextHeight * nextRatio)
      if (
        nextWidth === cssWidth &&
        nextHeight === cssHeight &&
        nextRatio === ratio &&
        canvas.width === width &&
        canvas.height === height
      ) {
        return false
      }
      cssWidth = nextWidth
      cssHeight = nextHeight
      ratio = nextRatio
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      version++
      return true
    },

    setLook(next) {
      if (
        look &&
        look.blurPx === next.blurPx &&
        look.saturate === next.saturate &&
        look.opacity === next.opacity &&
        look.scale === next.scale
      ) {
        return
      }
      look = next
      version++
    },

    compose(input, image, cut) {
      const current = input ? image(input.current) : null
      let previous = input?.previous ? image(input.previous) : null
      let mix = input ? input.mix : 1
      if (cut && previous === null) mix = 1
      if (mix >= 1) previous = null

      if (
        version === lastVersion &&
        current === lastCurrent &&
        previous === lastPrevious &&
        mix === lastMix
      ) {
        return
      }
      lastVersion = version
      lastCurrent = current
      lastPrevious = previous
      lastMix = mix

      prune(current, previous)
      if (!context || !look) {
        drawn = false
        return
      }
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'

      const alphas = crossfadeAlphas(mix, look.opacity)
      const drewPrevious = previous ? drawLayer(previous, alphas.previous) : false
      // Added, not laid over: the sum of the two is an exact lerp (`crossfadeAlphas`).
      if (drewPrevious) context.globalCompositeOperation = 'lighter'
      const drewCurrent = drawLayer(current, alphas.current)
      context.globalCompositeOperation = 'source-over'
      context.globalAlpha = 1
      drawn = drewPrevious || drewCurrent || current === null
    },

    dispose() {
      smalls.clear()
      look = null
      drawn = false
    }
  }
}

/**
 * The library's placeholder cover, decoded once for the wash. The CSS wash
 * shows it (the `<img>` takes any artwork URL), so the canvas wash has to as
 * well, or handing off a track without art would fade a veil out. Effects
 * never see it: their stand-in is the synthetic cover (D35.11).
 */
export async function decodeWashImage(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`wash image fetch failed: ${response.status}`)
  return createImageBitmap(await response.blob())
}
