import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, uniformLocations } from '../gl/program'
import { PaletteSlot, type Palette } from '../palette'
import {
  createWhorlModel,
  INSTANCE_FLOATS,
  MAX_INSTANCES,
  WHORL_KNOBS,
  WhorlColour
} from './whorlModel'

/**
 * **Whorl** on the WebGL2 tier — W23-7, ported by W23-16. The tunnel itself is
 * `whorlModel.ts`; this draws it.
 *
 * Every stroke — each past ring, then the live ring's band and core — is one
 * instance of a closed triangle strip, all of them in one draw. A ring's shape
 * lives in a row of an `R32F` texture (`points` × rows); a frame uploads the
 * live row and, when the model snapshotted one, that row, so a ring's shape
 * crosses the bus once in its life. The vertex shader lays the shape round the
 * circle, as the 2D version did with `lineTo`, and pushes each point out along
 * the mitred normal by half the line width plus a pixel; the fragment shader
 * turns the distance across the strip into coverage, so the edges are smooth
 * without multisampling.
 *
 * `overlay`, so the host fades it in over the wash; blended premultiplied over
 * a cleared, transparent canvas. Colours are the palette's sRGB values, as the
 * 2D version stroked them, so blending happens in the same space it did there.
 */

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec4 a_ring;
layout(location = 1) in vec4 a_style;
uniform sampler2D u_shapes;
uniform int u_points;
uniform vec2 u_size;
uniform vec3 u_colours[2];
out float v_across;
flat out float v_halfWidth;
flat out float v_extent;
flat out vec4 v_colour;

const float TAU = 6.28318530718;
// The mitre may lengthen the extrusion this much at most, so a sharp spike in
// the waveform thickens its tip rather than throwing a sliver across the stage.
const float MITRE_LIMIT = 2.0;

vec2 at(int point) {
  int p = point - (point / u_points) * u_points;
  if (p < 0) p += u_points;
  float shape = texelFetch(u_shapes, ivec2(p, int(a_ring.w)), 0).r;
  float r = a_ring.x + shape * a_ring.y;
  float angle = float(p) / float(u_points) * TAU + a_ring.z;
  return u_size * 0.5 + vec2(cos(angle), sin(angle)) * r;
}

vec2 direction(vec2 d) {
  float l = length(d);
  return l > 1e-4 ? d / l : vec2(1.0, 0.0);
}

void main() {
  // A closed strip: points + 1 pairs, the last pair back on point 0.
  int point = gl_VertexID >> 1;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec2 p = at(point);
  vec2 inbound = direction(p - at(point - 1));
  vec2 outbound = direction(at(point + 1) - p);
  vec2 tangent = direction(inbound + outbound);
  vec2 normal = vec2(-tangent.y, tangent.x);
  float mitre = 1.0 / max(dot(normal, vec2(-inbound.y, inbound.x)), 1.0 / MITRE_LIMIT);

  float halfWidth = a_style.x * 0.5;
  // A pixel past the line's edge, so the fragment shader has room to fade it.
  float extent = halfWidth + 1.0;
  vec2 q = p + normal * (side * extent * mitre);
  // Pixels are y down, as the 2D version drew them; clip space is y up.
  gl_Position = vec4(q.x / u_size.x * 2.0 - 1.0, 1.0 - q.y / u_size.y * 2.0, 0.0, 1.0);

  v_across = side;
  v_halfWidth = halfWidth;
  v_extent = extent;
  float alpha = a_style.y;
  v_colour = vec4(u_colours[int(a_style.z)] * alpha, alpha);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in float v_across;
flat in float v_halfWidth;
flat in float v_extent;
flat in vec4 v_colour;
out vec4 o_colour;
void main() {
  float distance = abs(v_across) * v_extent;
  o_colour = v_colour * clamp(v_halfWidth + 0.5 - distance, 0.0, 1.0);
}
`

const UNIFORMS = ['u_shapes', 'u_points', 'u_size', 'u_colours'] as const

/** Linear light back to the sRGB encoding the 2D version's `css` strings carried. */
function encode(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
}

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Whorl draws on a WebGL2 surface')
  const gl = target.context
  const program = compileProgram(gl, FRAGMENT_SHADER, 'Whorl', VERTEX_SHADER)
  const u = uniformLocations(gl, program, UNIFORMS)
  const model = createWhorlModel(target.quality, target.params)
  const { points, rows, shapes, instances } = model

  const shapeTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, shapeTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, points, rows)
  gl.bindTexture(gl.TEXTURE_2D, null)

  const instanceBuffer = gl.createBuffer()
  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * INSTANCE_FLOATS * 4, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0)
  gl.vertexAttribDivisor(0, 1)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, 16)
  gl.vertexAttribDivisor(1, 1)
  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)

  gl.useProgram(program)
  gl.uniform1i(u.u_shapes, 0)
  gl.uniform1i(u.u_points, points)
  gl.useProgram(null)

  const colours = new Float32Array(6)
  let coloursVersion = -1
  let width = 1
  let height = 1

  function uploadRow(row: number): void {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, points, 1, gl.RED, gl.FLOAT, shapes, row * points)
  }

  function updateColours(palette: Palette): void {
    if (palette.version === coloursVersion) return
    coloursVersion = palette.version
    for (let channel = 0; channel < 3; channel++) {
      colours[WhorlColour.accent * 3 + channel] = encode(
        palette.linear[PaletteSlot.accent * 3 + channel]
      )
      colours[WhorlColour.highlighted * 3 + channel] = encode(
        palette.linear[PaletteSlot.textHighlighted * 3 + channel]
      )
    }
  }

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
    },

    frame(audio, palette, stage, dtSec) {
      model.update(audio, stage.intensity, width, height, dtSec)
      updateColours(palette)

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, shapeTexture)
      // Rows are tightly packed floats; say so rather than trust the default.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      uploadRow(rows - 1)
      if (model.snapshotRow >= 0) uploadRow(model.snapshotRow)

      const count = model.count
      if (count > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * INSTANCE_FLOATS)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)

        gl.useProgram(program)
        gl.uniform2f(u.u_size, width, height)
        gl.uniform3fv(u.u_colours, colours)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.bindVertexArray(vao)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (points + 1) * 2, count)
        gl.bindVertexArray(null)
        gl.disable(gl.BLEND)
        gl.useProgram(null)
      }
      gl.bindTexture(gl.TEXTURE_2D, null)
    },

    dispose() {
      gl.deleteVertexArray(vao)
      gl.deleteBuffer(instanceBuffer)
      gl.deleteTexture(shapeTexture)
      gl.deleteProgram(program)
    }
  }
}

/** W23-7: the waveform as a ring, its afterimages spiralling outward. */
export const WHORL: VisualizerEffect = {
  id: 'whorl',
  label: 'Whorl',
  surface: 'webgl2',
  emergence: 'overlay',
  params: WHORL_KNOBS,
  create
}
