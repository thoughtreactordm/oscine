import { createLumaReadback, type LumaReadback } from './lumaReadback'

/**
 * The flash guard's sample on the 2D tier — **W23-16, D35.8**.
 *
 * Any synchronous read of a 2D canvas — a `drawImage` out of it, a 1×1
 * `getImageData` — first makes the canvas finish everything drawn into it,
 * there and then, on the main thread. On Windows (Ganesh over ANGLE/D3D11) that
 * measured 50–60 ms per read at 1440p whatever the read's size or method, and
 * at every other frame it held the renderer at 18 fps. Putting the read after
 * the frame does not help: the canvas still has to finish for the read.
 *
 * So the 2D canvas is not read here at all. It is copied into a texture in a
 * helper WebGL2 context — `texImage2D` from an accelerated canvas is a GPU-side
 * copy that nothing waits on (0.1 ms measured) — and that texture is sampled
 * with the WebGL tier's own fenced readback, collected a frame or two later.
 *
 * The helper is a 1×1 `OffscreenCanvas`: it never draws or presents anything.
 * It is made with the stage's `failIfMajorPerformanceCaveat`, so with no real
 * GPU there is no helper and the host keeps its synchronous sample — on a
 * software canvas that read is a memory copy, which is what it was written for.
 */

export interface CanvasLuma {
  /** Copy `canvas` and issue a sample of it. Skipped while both readbacks are in flight. */
  request(canvas: HTMLCanvasElement): void
  /** The luminance of the oldest sample that has landed, or null. Call once a frame. */
  poll(): number | null
  /** The helper context was lost: drop this and fall back. */
  readonly lost: boolean
  dispose(): void
}

const HELPER_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: true,
  powerPreference: 'default'
}

/** Null when no hardware WebGL2 context can be had. */
export function createCanvasLuma(): CanvasLuma | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const helper = new OffscreenCanvas(1, 1)
  const gl = helper.getContext('webgl2', HELPER_ATTRIBUTES) as WebGL2RenderingContext | null
  if (!gl || gl.isContextLost()) return null

  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)
  const readback: LumaReadback = createLumaReadback(gl)
  let attached = false

  return {
    get lost() {
      return gl.isContextLost()
    },

    request(canvas) {
      const width = canvas.width
      const height = canvas.height
      if (width === 0 || height === 0 || gl.isContextLost()) return
      gl.bindTexture(gl.TEXTURE_2D, texture)
      // Premultiplied, as the canvas holds it, so the copy needs no conversion
      // and `meanLuminance` undoes it exactly as it does for the WebGL tier.
      // Rows stay as they are: a mean does not care which way up it is.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
      gl.bindTexture(gl.TEXTURE_2D, null)
      if (!attached) {
        // Once: re-specifying the texture, at any size, keeps it attached.
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        attached = true
      }
      readback.request(width, height, framebuffer)
    },

    poll() {
      if (gl.isContextLost()) return null
      return readback.poll()
    },

    dispose() {
      if (!gl.isContextLost()) {
        readback.dispose()
        gl.deleteFramebuffer(framebuffer)
        gl.deleteTexture(texture)
      }
      // Give the context back now rather than at GC: Chromium caps live contexts.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}
