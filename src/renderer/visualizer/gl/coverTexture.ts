import type { StageCoverInput, StageCoverSlot } from '../coverDecode'

/**
 * Cover textures — **W23-8, D35.11**.
 *
 * One helper uploads every cover, so the texture rules cannot drift between
 * effects:
 *
 * - `SRGB8_ALPHA8`, so sampling returns linear light and blends are correct;
 * - mipmaps generated at upload and sampled `LINEAR_MIPMAP_LINEAR` — the mips
 *   are also the blur pyramid the GPU wash downsamples through (D35.12);
 * - `MIRRORED_REPEAT`, so kaleidoscope and tunnel sampling past 0..1 has no
 *   seams;
 * - one flip convention: **unflipped**, top row at v = 0. `UNPACK_FLIP_Y_WEBGL`
 *   is set false explicitly, because it is ignored for `ImageBitmap` sources
 *   and so cannot be the convention; `coverFit.ts` flips in the UV transform.
 * - `aspect` is the slot's, passed by effects as a uniform (`coverUvTransform`).
 *
 * Texels are straight alpha: Chromium uploads an `ImageBitmap` created with the
 * default `premultiplyAlpha` unpremultiplied. Covers are nearly always opaque,
 * so this only matters for the odd PNG.
 *
 * The manager below is the only thing that fills `CoverSlot.texture`. It is
 * per context: a texture belongs to the context that made it, so a new canvas
 * (a 2D ↔ WebGL swap) or a restored context gets a new manager and re-uploads
 * from the host's retained bitmaps — an effect never holds the only copy.
 */

/** Upload one bitmap with D35.11's rules. Null when the context is lost or the bitmap closed. */
export function uploadCoverTexture(
  gl: WebGL2RenderingContext,
  bitmap: ImageBitmap
): WebGLTexture | null {
  const width = bitmap.width
  const height = bitmap.height
  if (width === 0 || height === 0) return null
  const texture = gl.createTexture()
  if (!texture) return null
  const levels = 1 + Math.floor(Math.log2(Math.max(width, height)))
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, width, height)
  try {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
  } catch {
    // A bitmap closed under us (the slot was released mid-frame).
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.deleteTexture(texture)
    return null
  }
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return texture
}

export interface CoverTextures {
  /** The texture for a bitmap, uploading it the first time. */
  textureFor(bitmap: ImageBitmap): WebGLTexture | null
  /**
   * Once per frame: fill `texture` on the slots showing, and delete the
   * textures of every bitmap not among them or `keep` (the wash placeholder).
   */
  sync(input: StageCoverInput | null, keep: ImageBitmap | null): void
  /** A slot is being let go of (its bitmap is about to close): delete its texture now. */
  release(slot: StageCoverSlot): void
  /** Delete everything, and clear `texture` on every slot this filled. */
  dispose(): void
}

export function createCoverTextures(gl: WebGL2RenderingContext): CoverTextures {
  const textures = new Map<ImageBitmap, WebGLTexture>()
  const filled = new Set<StageCoverSlot>()

  function textureFor(bitmap: ImageBitmap): WebGLTexture | null {
    const existing = textures.get(bitmap)
    if (existing) return existing
    const texture = uploadCoverTexture(gl, bitmap)
    if (texture) textures.set(bitmap, texture)
    return texture
  }

  function fill(slot: StageCoverSlot): void {
    slot.texture = textureFor(slot.bitmap)
    filled.add(slot)
  }

  function drop(bitmap: ImageBitmap): void {
    const texture = textures.get(bitmap)
    if (!texture) return
    gl.deleteTexture(texture)
    textures.delete(bitmap)
  }

  return {
    textureFor,
    sync(input, keep) {
      const current = input?.current ?? null
      const previous = input?.previous ?? null
      if (current) fill(current)
      if (previous) fill(previous)
      for (const slot of filled) {
        if (slot !== current && slot !== previous) {
          slot.texture = null
          filled.delete(slot)
        }
      }
      for (const bitmap of textures.keys()) {
        if (bitmap !== current?.bitmap && bitmap !== previous?.bitmap && bitmap !== keep) {
          drop(bitmap)
        }
      }
    },
    release(slot) {
      drop(slot.bitmap)
      slot.texture = null
      filled.delete(slot)
    },
    dispose() {
      for (const texture of textures.values()) gl.deleteTexture(texture)
      textures.clear()
      for (const slot of filled) slot.texture = null
      filled.clear()
    }
  }
}
