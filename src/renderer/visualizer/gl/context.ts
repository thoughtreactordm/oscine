/**
 * Getting a WebGL2 context — **W23-8, D35.6 / R16**.
 *
 * The probe and the stage canvas ask with the same attributes, so a probe that
 * passes means the stage's context will come up the same way.
 * `failIfMajorPerformanceCaveat` is how Chromium refuses a context backed by
 * software rendering (SwiftShader on a blocklisted GPU, `--disable-gpu`); it is
 * the whole capability check — no IPC, no `app.getGPUFeatureStatus()`.
 */

export const GL_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  // The luminance readback blits the drawing buffer at a new size, which a
  // multisampled default framebuffer does not allow; effects that want edges
  // smoothed do it themselves.
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  failIfMajorPerformanceCaveat: true,
  powerPreference: 'default'
}

/**
 * Once per session: can this machine run the WebGL tier? A throwaway context
 * on an offscreen canvas, released as soon as it has answered.
 */
export function probeWebGl2(): boolean {
  if (typeof OffscreenCanvas === 'undefined') return false
  const canvas = new OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2', GL_CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null
  if (!gl) return false
  const ok = !gl.isContextLost()
  // Give the context back now rather than at GC: Chromium caps live contexts.
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return ok
}
