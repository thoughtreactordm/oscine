/**
 * Cover-fit UV maths for the WebGL tier — **W23-8, D35.11**.
 *
 * One convention, so effects cannot drift:
 *
 * - **Covers are uploaded unflipped.** `UNPACK_FLIP_Y_WEBGL` is set false
 *   explicitly — it is ignored for `ImageBitmap` sources anyway, which is why
 *   flipping at upload cannot be the convention — so a cover's top row is
 *   v = 0.
 * - **Screen UVs are GL's**: (0, 0) is the bottom-left of the target, as a
 *   full-screen triangle's `uv = position * 0.5 + 0.5` gives them. Rendered
 *   textures (the wash, ping-pong targets) are in this orientation too and are
 *   sampled with screen UVs as they are.
 * - **The cover transform does the flip.** {@link coverUvTransform} maps a
 *   screen UV to a cover UV as `uv * xy + zw`, with object-cover fit (centred,
 *   CSS's default `object-position`), an optional zoom about the centre (the
 *   wash's `scale()`), and v flipped so the cover is upright.
 *
 * Sampling outside 0..1 is defined: covers are `MIRRORED_REPEAT`, so a
 * kaleidoscope or tunnel that runs off the edge mirrors rather than seams.
 *
 * Pure and DOM-free.
 */

/** `[scaleX, scaleY, offsetX, offsetY]`: `coverUv = screenUv * xy + zw`. */
export type UvTransform = readonly [number, number, number, number]

/**
 * The visible fraction of a cover of aspect `coverAspect` (width / height)
 * under object-cover in a box of aspect `boxAspect`, as y-down scale and
 * offset: the box's (u, v-down) maps to `(u * sx + ox, v * sy + oy)`.
 */
export function objectCoverUv(coverAspect: number, boxAspect: number): UvTransform {
  if (!(coverAspect > 0) || !(boxAspect > 0)) return [1, 1, 0, 0]
  if (coverAspect > boxAspect) {
    // Wider than the box: full height, a centred band of the width.
    const sx = boxAspect / coverAspect
    return [sx, 1, (1 - sx) / 2, 0]
  }
  const sy = coverAspect / boxAspect
  return [1, sy, 0, (1 - sy) / 2]
}

/**
 * Screen UV (GL, y-up) → cover UV (y-down, as uploaded), object-cover fitted
 * and zoomed by `zoom` about the centre (`zoom` > 1 shows less of the cover,
 * as CSS `scale()` on the layer does). Writes into `out` when given, so the
 * per-frame path can reuse one array.
 */
export function coverUvTransform(
  coverAspect: number,
  boxAspect: number,
  zoom = 1,
  out: number[] | Float32Array = [0, 0, 0, 0]
): number[] | Float32Array {
  const [sx, sy, ox, oy] = objectCoverUv(coverAspect, boxAspect)
  const z = zoom > 0 ? zoom : 1
  const scaleX = sx / z
  const scaleY = sy / z
  const offsetX = ox + sx * (0.5 - 0.5 / z)
  const offsetY = oy + sy * (0.5 - 0.5 / z)
  // v-down = 1 − v-up: fold the flip into the y row.
  out[0] = scaleX
  out[1] = -scaleY
  out[2] = offsetX
  out[3] = scaleY + offsetY
  return out
}
