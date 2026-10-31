import { computeSwatches, type CoverInput, type CoverSlot } from './cover'
import { createCoverSource, type CoverSource } from './coverSource'

/**
 * The DOM half of the cover input — **W23-3, D35.11**. Kept as thin as
 * `artworkAccent.ts`, whose route it follows; the judgement is in `cover.ts`
 * and `coverSource.ts`, which is where the tests are.
 */

export type StageCoverSlot = CoverSlot<ImageBitmap, WebGLTexture>
export type StageCoverInput = CoverInput<StageCoverSlot>

/**
 * The edge the cover is drawn down to before the swatches are read. Each 4×4
 * cell then averages a 16² block of an already high-quality downscale, which
 * is all sixteen colours need.
 */
const SWATCH_SAMPLE_EDGE = 64

/**
 * `fetch` → blob → `createImageBitmap`, as `readAccentSeed` does: off the main
 * thread, no new IPC, and the bitmap is untainted so W23-8 may upload it. The
 * bitmap is kept at the size the library serves (the 640-px tier); only the
 * swatch sample is scaled.
 */
export async function decodeCover(url: string, signal: AbortSignal): Promise<StageCoverSlot> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`cover fetch failed: ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  try {
    const canvas = new OffscreenCanvas(SWATCH_SAMPLE_EDGE, SWATCH_SAMPLE_EDGE)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('no 2d context for the swatch sample')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, SWATCH_SAMPLE_EDGE, SWATCH_SAMPLE_EDGE)
    const sample = context.getImageData(0, 0, SWATCH_SAMPLE_EDGE, SWATCH_SAMPLE_EDGE)
    return {
      bitmap,
      texture: null,
      aspect: bitmap.height > 0 ? bitmap.width / bitmap.height : 1,
      swatches: computeSwatches(sample.data, SWATCH_SAMPLE_EDGE, SWATCH_SAMPLE_EDGE),
      synthetic: false
    }
  } catch (error) {
    bitmap.close()
    throw error
  }
}

/**
 * Stand-in pixels to a bitmap, synchronously: `transferToImageBitmap` hands
 * over the canvas's backing store, so a repaint mid palette-lerp lands on the
 * same frame instead of racing an async decode.
 */
function createStandInPainter(): (
  pixels: Uint8ClampedArray,
  edge: number,
  swatches: Float32Array
) => StageCoverSlot {
  let canvas: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null
  let image: ImageData | null = null

  return (pixels, edge, swatches) => {
    if (!canvas || canvas.width !== edge) {
      canvas = new OffscreenCanvas(edge, edge)
      context = canvas.getContext('2d')
      image = null
    }
    if (!image || image.data !== pixels) {
      image = new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, edge, edge)
    }
    context?.putImageData(image, 0, 0)
    return {
      bitmap: canvas.transferToImageBitmap(),
      texture: null,
      aspect: 1,
      swatches,
      synthetic: true
    }
  }
}

/** The stage's cover source, wired to the real decoder. */
export function createStageCoverSource(): CoverSource<StageCoverSlot> {
  return createCoverSource<StageCoverSlot>({
    decode: decodeCover,
    standIn: createStandInPainter()
  })
}
