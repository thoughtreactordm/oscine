import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, uniformLocations } from '../gl/program'
import type { Palette } from '../palette'
import { encodeStrokeColours } from './strokeRenderer'
import { createUpdraftModel, SEGMENT_FLOATS, UPDRAFT_KNOBS } from './updraftModel'

/**
 * **Updraft** on the WebGL2 tier — W23-7, ported by W23-16. The air and the
 * motes are `updraftModel.ts`, simulated on the CPU as before; this draws their
 * trails.
 *
 * Every trail segment is one instance of a quad around it, all in one draw: the
 * quad is the segment's capsule grown by a pixel, and the fragment shader turns
 * the distance to the segment into coverage — the 2D version's round cap, and
 * smooth edges, without multisampling. Segments of different ages overlap at
 * their joints and blend there, as the 2D version's per-age strokes did.
 *
 * `overlay`, so the host fades it in over the wash; blended premultiplied over
 * a cleared, transparent canvas, in the palette's sRGB values as the 2D version
 * stroked them.
 */

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_segment;
layout(location = 1) in vec4 a_style;
uniform vec2 u_size;
uniform vec3 u_colours[2];
out vec2 v_pixel;
flat out vec4 v_ends;
flat out float v_halfWidth;
flat out vec4 v_colour;

void main() {
  // Triangle strip corners: (-1,-1), (1,-1), (-1,1), (1,1).
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vec2 a = a_segment.xy;
  vec2 b = a_segment.zw;
  vec2 d = b - a;
  float l = length(d);
  vec2 along = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 across = vec2(-along.y, along.x);
  float halfWidth = a_style.x * 0.5;
  // The capsule plus a pixel all round, so the fragment shader has room to fade it.
  float extent = halfWidth + 1.0;
  vec2 middle = (a + b) * 0.5;
  vec2 p = middle + along * (corner.x * (l * 0.5 + extent)) + across * (corner.y * extent);
  // Pixels are y down, as the 2D version drew them; clip space is y up.
  gl_Position = vec4(p.x / u_size.x * 2.0 - 1.0, 1.0 - p.y / u_size.y * 2.0, 0.0, 1.0);

  v_pixel = p;
  v_ends = a_segment;
  v_halfWidth = halfWidth;
  float alpha = a_style.y;
  v_colour = vec4(u_colours[int(a_style.z)] * alpha, alpha);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_pixel;
flat in vec4 v_ends;
flat in float v_halfWidth;
flat in vec4 v_colour;
out vec4 o_colour;
void main() {
  vec2 a = v_ends.xy;
  vec2 ab = v_ends.zw - a;
  float t = clamp(dot(v_pixel - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  float distance = length(v_pixel - (a + ab * t));
  o_colour = v_colour * clamp(v_halfWidth + 0.5 - distance, 0.0, 1.0);
}
`

const UNIFORMS = ['u_size', 'u_colours'] as const

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Updraft draws on a WebGL2 surface')
  const gl = target.context
  const program = compileProgram(gl, FRAGMENT_SHADER, 'Updraft', VERTEX_SHADER)
  const u = uniformLocations(gl, program, UNIFORMS)
  const model = createUpdraftModel(target.quality, target.params)

  const instanceBuffer = gl.createBuffer()
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, model.maxSegments * SEGMENT_FLOATS * 4, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, SEGMENT_FLOATS * 4, 0)
  gl.vertexAttribDivisor(0, 1)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, SEGMENT_FLOATS * 4, 16)
  gl.vertexAttribDivisor(1, 1)
  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)

  const colours = new Float32Array(6)
  let coloursVersion = -1
  let width = 1
  let height = 1

  function updateColours(palette: Palette): void {
    if (palette.version === coloursVersion) return
    coloursVersion = palette.version
    encodeStrokeColours(palette, colours)
  }

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
      model.resize(width, height)
    },

    frame(audio, palette, stage, dtSec) {
      model.update(audio, stage.intensity, dtSec)
      updateColours(palette)

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      const count = model.count
      if (count === 0) return
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, model.instances, 0, count * SEGMENT_FLOATS)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)

      gl.useProgram(program)
      gl.uniform2f(u.u_size, width, height)
      gl.uniform3fv(u.u_colours, colours)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.bindVertexArray(vao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
      gl.bindVertexArray(null)
      gl.disable(gl.BLEND)
      gl.useProgram(null)
    },

    dispose() {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(instanceBuffer)
      gl.deleteProgram(program)
    }
  }
}

/** W23-7: motes on a swirling flow field, trailing smoke. */
export const UPDRAFT: VisualizerEffect = {
  id: 'updraft',
  label: 'Updraft',
  surface: 'webgl2',
  emergence: 'overlay',
  params: UPDRAFT_KNOBS,
  create
}
