/**
 * Render targets and the ping-pong pair — **W23-8, D35.6**.
 *
 * A target is an `RGBA8` texture behind a framebuffer, `LINEAR` and
 * `CLAMP_TO_EDGE`, y-up like everything rendered (`coverFit.ts`). Its colour is
 * whatever its writer puts there; the wash pass keeps premultiplied,
 * sRGB-encoded values in them, the way a 2D canvas holds its pixels.
 *
 * The ping-pong pair is two of them: draw into `write` sampling `read`, then
 * `swap()`. Feedback effects use it frame to frame; the wash pass uses it for
 * the two halves of its separable blur.
 *
 * `'rg16f'` (W23-11) is for state that is not a colour: Rainfall's height
 * field, which is signed and needs more than 8 bits. Rendering to it needs
 * `EXT_color_buffer_float`; half-float filtering is core in WebGL2. Without
 * the extension the target throws, which an effect's `create` turns into
 * "unavailable" (D35.6), never into a broken stage.
 */

export type RenderTargetFormat = 'rgba8' | 'rg16f'

export interface RenderTarget {
  readonly texture: WebGLTexture
  readonly framebuffer: WebGLFramebuffer
  readonly width: number
  readonly height: number
  /** Bind for drawing and set the viewport to cover it. */
  bind(): void
  /** Reallocate at a new size; the contents are undefined afterwards. */
  resize(width: number, height: number): void
  dispose(): void
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: RenderTargetFormat = 'rgba8'
): RenderTarget {
  if (format === 'rg16f' && !gl.getExtension('EXT_color_buffer_float')) {
    throw new Error('render target: rg16f needs EXT_color_buffer_float')
  }
  const texture = gl.createTexture()
  const framebuffer = gl.createFramebuffer()
  if (!texture || !framebuffer) throw new Error('render target: the context is lost')
  let w = 0
  let h = 0

  function allocate(nextWidth: number, nextHeight: number): void {
    w = Math.max(1, Math.round(nextWidth))
    h = Math.max(1, Math.round(nextHeight))
    gl.bindTexture(gl.TEXTURE_2D, texture)
    if (format === 'rg16f') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.HALF_FLOAT, null)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const complete =
      format === 'rgba8' || gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (!complete) throw new Error(`render target: ${format} is not renderable here`)
  }

  try {
    allocate(width, height)
  } catch (error) {
    gl.deleteFramebuffer(framebuffer)
    gl.deleteTexture(texture)
    throw error
  }

  return {
    texture,
    framebuffer,
    get width() {
      return w
    },
    get height() {
      return h
    },
    bind() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.viewport(0, 0, w, h)
    },
    resize(nextWidth, nextHeight) {
      if (Math.round(nextWidth) === w && Math.round(nextHeight) === h) return
      allocate(nextWidth, nextHeight)
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
    }
  }
}

export interface PingPong {
  /** The target last written: sample this. */
  readonly read: RenderTarget
  /** The target to draw into next. */
  readonly write: RenderTarget
  swap(): void
  resize(width: number, height: number): void
  dispose(): void
}

export function createPingPong(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  format: RenderTargetFormat = 'rgba8'
): PingPong {
  let read = createRenderTarget(gl, width, height, format)
  let write: RenderTarget
  try {
    write = createRenderTarget(gl, width, height, format)
  } catch (error) {
    read.dispose()
    throw error
  }
  return {
    get read() {
      return read
    },
    get write() {
      return write
    },
    swap() {
      const previous = read
      read = write
      write = previous
    },
    resize(nextWidth, nextHeight) {
      read.resize(nextWidth, nextHeight)
      write.resize(nextWidth, nextHeight)
    },
    dispose() {
      read.dispose()
      write.dispose()
    }
  }
}
