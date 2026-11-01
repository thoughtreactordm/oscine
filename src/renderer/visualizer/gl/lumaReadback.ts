import { meanLuminance } from '../luminance'

/**
 * The flash guard's sample on the WebGL tier — **W23-8, D35.8**.
 *
 * An 8×8 `readPixels` of what the effect drew, without stalling the pipeline:
 *
 * - **Downsample on the GPU.** The drawing buffer is blitted `LINEAR` into
 *   64×64, then halved three times to 8×8. Each halving reads exactly the four
 *   texels under it, so those three are a true box average; the first blit
 *   reads 2×2 of each 1/64 cell, 16 384 points of the frame in all, which is
 *   plenty for a mean.
 * - **Read asynchronously.** `readPixels` goes into a pixel-pack buffer behind
 *   a fence; a later frame collects it once the fence has signalled. Two buffers
 *   alternate, so a sample is issued while the last is in flight. The answer
 *   arrives a frame or two late, which a guard that integrates over hundreds of
 *   milliseconds does not notice.
 *
 * The default framebuffer must be single-sampled (the host creates the context
 * with `antialias: false`), or a scaling blit from it is invalid. Readback is
 * premultiplied, which `meanLuminance` undoes.
 */

const EDGE = 8
const FIRST_EDGE = 64
const BYTES = EDGE * EDGE * 4
const SLOTS = 2

interface Slot {
  buffer: WebGLBuffer
  fence: WebGLSync | null
}

export interface LumaReadback {
  /** Issue a sample of the drawing buffer (`width`×`height`). Skipped while both buffers are in flight. */
  request(width: number, height: number): void
  /** The luminance of the oldest sample that has landed, or null. Call once a frame. */
  poll(): number | null
  dispose(): void
}

export function createLumaReadback(gl: WebGL2RenderingContext): LumaReadback {
  const edges: number[] = []
  for (let edge = FIRST_EDGE; edge >= EDGE; edge /= 2) edges.push(edge)
  const levels = edges.map((edge) => {
    const framebuffer = gl.createFramebuffer()
    const renderbuffer = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, edge, edge)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer)
    return { edge, framebuffer, renderbuffer }
  })
  gl.bindRenderbuffer(gl.RENDERBUFFER, null)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  const slots: Slot[] = []
  for (let index = 0; index < SLOTS; index++) {
    const buffer = gl.createBuffer()
    if (!buffer) break
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, BYTES, gl.STREAM_READ)
    slots.push({ buffer, fence: null })
  }
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  const pixels = new Uint8Array(BYTES)
  /** Issue order, so the oldest sample is collected first. */
  let next = 0
  let oldest = 0

  return {
    request(width, height) {
      const slot = slots[next]
      if (!slot || slot.fence || width === 0 || height === 0) return
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      let sourceWidth = width
      let sourceHeight = height
      for (const level of levels) {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, level.framebuffer)
        gl.blitFramebuffer(
          0,
          0,
          sourceWidth,
          sourceHeight,
          0,
          0,
          level.edge,
          level.edge,
          gl.COLOR_BUFFER_BIT,
          gl.LINEAR
        )
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, level.framebuffer)
        sourceWidth = level.edge
        sourceHeight = level.edge
      }
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
      gl.readPixels(0, 0, EDGE, EDGE, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      gl.flush()
      next = (next + 1) % slots.length
    },

    poll() {
      const slot = slots[oldest]
      if (!slot?.fence) return null
      const status = gl.clientWaitSync(slot.fence, 0, 0)
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) return null
      gl.deleteSync(slot.fence)
      slot.fence = null
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      oldest = (oldest + 1) % slots.length
      return meanLuminance(pixels, true)
    },

    dispose() {
      for (const slot of slots) {
        if (slot.fence) gl.deleteSync(slot.fence)
        gl.deleteBuffer(slot.buffer)
      }
      slots.length = 0
      for (const level of levels) {
        gl.deleteFramebuffer(level.framebuffer)
        gl.deleteRenderbuffer(level.renderbuffer)
      }
    }
  }
}
