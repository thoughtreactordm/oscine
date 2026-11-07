import { compileProgram, uniformLocations } from '../gl/program'
import { PaletteSlot, type Palette } from '../palette'
import { STROKE_FLOATS, StrokeColour, type StrokeSource } from './strokes'

/**
 * Instanced polyline strokes from shape rows — **W23-16**, shared by Whorl
 * (rings) and Trace (ribbons), the two effects that left the 2D tier for
 * stroking up to a hundred and fifty stage-sized anti-aliased paths a frame.
 *
 * A model owns the strokes; this only draws them. Each stroke is one instance
 * of a triangle strip along `points` samples of a shape row, every stroke in a
 * single draw:
 *
 * - **Shapes** live in an `R32F` texture, `points` × `rows`. A frame uploads
 *   the live row and, when the model snapshotted one, that row, so a shape
 *   crosses the bus once in its life.
 * - **Strokes** are {@link STROKE_FLOATS} floats each, drawing order. The first
 *   `vec4` places the shape (its meaning is the layout's, below) and names the
 *   row; the second is line width (px), alpha (flash guard included), a
 *   {@link StrokeColour}, and one more layout value.
 * - **Layouts.** A `ring` is closed, the shape laid round a circle at the
 *   target's centre: `(radius, swing, turn, row)`, `(width, alpha, colour, —)`.
 *   A `ribbon` is open, the shape laid left to right across the target:
 *   `(centreY, tilt, amplitude, row)`, `(width, alpha, colour, shiftX)` — `tilt`
 *   is the rise from the ribbon's middle to its right end, `shiftX` how far it
 *   has scrolled left. All in pixels, y down, as the 2D versions drew them.
 *
 * The vertex shader pushes each point out along its mitred normal by half the
 * line width plus a pixel; the fragment shader turns the distance across the
 * strip into coverage, so edges are smooth without multisampling. A ribbon's
 * ends are square, not the 2D round cap — at a pixel or three wide, on a
 * tapered shape, the difference is not visible. Colours are the palette's sRGB
 * values, as the 2D versions stroked them, so blending happens in the same
 * space it did there; blended premultiplied over whatever the effect cleared.
 */

export type StrokeLayout = 'ring' | 'ribbon'

export interface StrokeRenderer {
  /** Clear the default framebuffer and draw `source` into a `width`×`height` target. */
  draw(source: StrokeSource, palette: Palette, width: number, height: number): void
  dispose(): void
}

const RING_POSITION = `
const bool CLOSED = true;
vec2 place(float shape, float point) {
  float angle = point / float(u_points) * TAU + a_place.z;
  float r = a_place.x + shape * a_place.y;
  return u_size * 0.5 + vec2(cos(angle), sin(angle)) * r;
}
`

const RIBBON_POSITION = `
const bool CLOSED = false;
vec2 place(float shape, float point) {
  float along = point / float(u_points - 1);
  float x = along * u_size.x - a_style.w;
  float y = a_place.x + a_place.y * (along - 0.5) + shape * a_place.z;
  return vec2(x, y);
}
`

function vertexShader(layout: StrokeLayout): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(location = 0) in vec4 a_place;
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
${layout === 'ring' ? RING_POSITION : RIBBON_POSITION}
vec2 at(int point) {
  int p = point;
  if (CLOSED) {
    p = point - (point / u_points) * u_points;
    if (p < 0) p += u_points;
  } else {
    p = clamp(point, 0, u_points - 1);
  }
  return place(texelFetch(u_shapes, ivec2(p, int(a_place.w)), 0).r, float(p));
}

vec2 direction(vec2 d) {
  float l = length(d);
  return l > 1e-4 ? d / l : vec2(1.0, 0.0);
}

void main() {
  // A ring is closed: points + 1 pairs, the last back on point 0. A ribbon is
  // open: points pairs, and its end points take their one neighbour's direction.
  int point = gl_VertexID >> 1;
  float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
  vec2 p = at(point);
  vec2 inbound = direction(p - at(point - 1));
  vec2 outbound = direction(at(point + 1) - p);
  if (!CLOSED) {
    if (point <= 0) inbound = outbound;
    if (point >= u_points - 1) outbound = inbound;
  }
  vec2 tangent = direction(inbound + outbound);
  vec2 normal = vec2(-tangent.y, tangent.x);
  float mitre = 1.0 / max(dot(normal, vec2(-inbound.y, inbound.x)), 1.0 / MITRE_LIMIT);

  float halfWidth = a_style.x * 0.5;
  // A pixel past the line's edge, so the fragment shader has room to fade it.
  float extent = halfWidth + 1.0;
  vec2 q = p + normal * (side * extent * mitre);
  // Pixels are y down, as the 2D versions drew them; clip space is y up.
  gl_Position = vec4(q.x / u_size.x * 2.0 - 1.0, 1.0 - q.y / u_size.y * 2.0, 0.0, 1.0);

  v_across = side;
  v_halfWidth = halfWidth;
  v_extent = extent;
  float alpha = a_style.y;
  v_colour = vec4(u_colours[int(a_style.z)] * alpha, alpha);
}
`
}

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

/** Linear light back to the sRGB encoding the 2D versions' `css` strings carried. */
function encode(linear: number): number {
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055
}

/** Throws a `GlProgramError` if the shaders do not build; the host makes the effect unavailable. */
export function createStrokeRenderer(
  gl: WebGL2RenderingContext,
  label: string,
  layout: StrokeLayout,
  points: number,
  rows: number,
  maxStrokes: number
): StrokeRenderer {
  const program = compileProgram(gl, FRAGMENT_SHADER, label, vertexShader(layout))
  const u = uniformLocations(gl, program, UNIFORMS)
  const vertices = layout === 'ring' ? (points + 1) * 2 : points * 2

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
  gl.bufferData(gl.ARRAY_BUFFER, maxStrokes * STROKE_FLOATS * 4, gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STROKE_FLOATS * 4, 0)
  gl.vertexAttribDivisor(0, 1)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STROKE_FLOATS * 4, 16)
  gl.vertexAttribDivisor(1, 1)
  gl.bindVertexArray(null)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)

  gl.useProgram(program)
  gl.uniform1i(u.u_shapes, 0)
  gl.uniform1i(u.u_points, points)
  gl.useProgram(null)

  const colours = new Float32Array(6)
  let coloursVersion = -1

  function uploadRow(shapes: Float32Array, row: number): void {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, points, 1, gl.RED, gl.FLOAT, shapes, row * points)
  }

  function updateColours(palette: Palette): void {
    if (palette.version === coloursVersion) return
    coloursVersion = palette.version
    for (let channel = 0; channel < 3; channel++) {
      colours[StrokeColour.accent * 3 + channel] = encode(
        palette.linear[PaletteSlot.accent * 3 + channel]
      )
      colours[StrokeColour.highlighted * 3 + channel] = encode(
        palette.linear[PaletteSlot.textHighlighted * 3 + channel]
      )
    }
  }

  return {
    draw(source, palette, width, height) {
      updateColours(palette)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, shapeTexture)
      // Rows are tightly packed floats; say so rather than trust the default.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      uploadRow(source.shapes, rows - 1)
      if (source.snapshotRow >= 0) uploadRow(source.shapes, source.snapshotRow)

      const count = Math.min(source.count, maxStrokes)
      if (count > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, source.instances, 0, count * STROKE_FLOATS)
        gl.bindBuffer(gl.ARRAY_BUFFER, null)

        gl.useProgram(program)
        gl.uniform2f(u.u_size, width, height)
        gl.uniform3fv(u.u_colours, colours)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.bindVertexArray(vao)
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, vertices, count)
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
