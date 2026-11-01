/**
 * The flash guard's luminance sample, as arithmetic — **W23-8, D35.8**.
 *
 * Both tiers read an 8×8 downsample of the effect canvas: the 2D tier through
 * `getImageData` (straight alpha), the WebGL tier through an asynchronous
 * `readPixels` of its premultiplied drawing buffer. This turns either into the
 * mean relative luminance the canvas adds to the stage — alpha-weighted, since
 * it sits over the wash and a transparent pixel adds nothing.
 *
 * Pure and DOM-free.
 */

/** sRGB byte → linear light. */
export const LINEAR_BYTE: Float32Array = (() => {
  const table = new Float32Array(256)
  for (let byte = 0; byte < 256; byte++) {
    const c = byte / 255
    table[byte] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return table
})()

/**
 * The mean of `luminance(rgb) × alpha` over RGBA bytes. With `premultiplied`
 * the colour is divided back out of alpha first (to the nearest byte, which is
 * all the table needs).
 */
export function meanLuminance(data: ArrayLike<number>, premultiplied: boolean): number {
  const pixels = Math.floor(data.length / 4)
  if (pixels === 0) return 0
  let sum = 0
  for (let index = 0; index < pixels * 4; index += 4) {
    const alphaByte = data[index + 3]
    if (alphaByte === 0) continue
    let r = data[index]
    let g = data[index + 1]
    let b = data[index + 2]
    if (premultiplied && alphaByte < 255) {
      const unscale = 255 / alphaByte
      r = Math.min(255, Math.round(r * unscale))
      g = Math.min(255, Math.round(g * unscale))
      b = Math.min(255, Math.round(b * unscale))
    }
    const luminance = 0.2126 * LINEAR_BYTE[r] + 0.7152 * LINEAR_BYTE[g] + 0.0722 * LINEAR_BYTE[b]
    sum += luminance * (alphaByte / 255)
  }
  return sum / pixels
}
