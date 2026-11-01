/**
 * Program compilation for the WebGL2 tier — **W23-8, D35.6**.
 *
 * Raw WebGL2, no library. A program that fails to compile or link throws a
 * {@link GlProgramError} carrying the driver's info log, which the host turns
 * into "this effect is unavailable for the session" and logs once — never a
 * broken stage. A context that is already lost fails every compile with an
 * empty log; that throws {@link GlContextLostError} instead, so a loss is never
 * mistaken for a bad shader.
 */

export class GlProgramError extends Error {
  constructor(
    readonly label: string,
    readonly stage: 'vertex' | 'fragment' | 'link',
    readonly log: string
  ) {
    super(`${label}: ${stage} ${stage === 'link' ? 'failed' : 'shader failed to compile'}\n${log}`)
    this.name = 'GlProgramError'
  }
}

export class GlContextLostError extends Error {
  constructor(label: string) {
    super(`${label}: the WebGL context is lost`)
    this.name = 'GlContextLostError'
  }
}

/**
 * The full-screen triangle's vertex shader: no buffers, three `gl_VertexID`s
 * cover clip space, and `v_uv` is the screen UV — (0, 0) at the bottom-left,
 * GL's orientation (`coverFit.ts` has the convention).
 */
export const FULLSCREEN_VERTEX_SHADER = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  label: string
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new GlContextLostError(label)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? ''
    gl.deleteShader(shader)
    if (gl.isContextLost()) throw new GlContextLostError(label)
    throw new GlProgramError(label, type === gl.VERTEX_SHADER ? 'vertex' : 'fragment', log)
  }
  return shader
}

/** Compile and link, surfacing the info log. Defaults to the full-screen vertex shader. */
export function compileProgram(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
  label: string,
  vertexSource: string = FULLSCREEN_VERTEX_SHADER
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, label)
  let fragment: WebGLShader
  try {
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, label)
  } catch (error) {
    gl.deleteShader(vertex)
    throw error
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    throw new GlContextLostError(label)
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  // Linked programs keep working once their shaders are flagged for deletion.
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? ''
    gl.deleteProgram(program)
    if (gl.isContextLost()) throw new GlContextLostError(label)
    throw new GlProgramError(label, 'link', log)
  }
  return program
}

/** Uniform locations by name, looked up once. A name the linker optimised away is null. */
export function uniformLocations<Name extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly Name[]
): Record<Name, WebGLUniformLocation | null> {
  const locations = {} as Record<Name, WebGLUniformLocation | null>
  for (const name of names) locations[name] = gl.getUniformLocation(program, name)
  return locations
}

export interface FullscreenTriangle {
  /** Bind the (empty) vertex array and draw the three vertices. */
  draw(): void
  dispose(): void
}

/** One full-screen triangle: an empty vertex array and three vertex IDs. */
export function createFullscreenTriangle(gl: WebGL2RenderingContext): FullscreenTriangle {
  const vao = gl.createVertexArray()
  return {
    draw() {
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      gl.deleteVertexArray(vao)
    }
  }
}
