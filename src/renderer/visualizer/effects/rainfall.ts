import { gammaEncode } from '@shared/theme'
import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, createFullscreenTriangle, uniformLocations } from '../gl/program'
import { createPingPong, type PingPong } from '../gl/target'
import { PaletteSlot, type Palette } from '../palette'
import { COVER_LAYER_GLSL, COVER_LAYER_UNIFORMS, createCoverLayer } from './coverLayer'
import { createRainfallModel, simSize, WAVE_C2 } from './rainfallModel'

/**
 * **Rainfall**: a height-field ripple over the cover (W23-11, D35.9, D35.11,
 * D35.12). Each onset drops a ring, sized by its strength and placed by its
 * dominant band.
 *
 * Two kinds of pass a frame:
 *
 * 1. **Step**, zero or more times, into the ping-pong's `write`: one fixed
 *    step of the damped wave equation on an `RG16F` field (R = height now,
 *    G = height a step ago), with the current drop's Gaussian added on the
 *    frame's first step. The grid, the step and every rate are in
 *    `rainfallModel.ts`. They are fixed in stage units, so the ripples look
 *    the same at any internal resolution and frame rate.
 * 2. **Present**, into the default framebuffer at the internal resolution:
 *    the slope of the (bilinearly sampled) field refracts the wash and the
 *    cover layer (`coverLayer.ts`). Crests facing the light pick up the
 *    palette's highlight. The result goes over the unmoved wash by the flash
 *    guard's intensity (D35.8).
 *
 * At emergence 0 the present pass returns `texture(u_wash, v_uv)` before
 * reading the field, so Rainfall there *is* the wash whatever the surface still
 * holds. Output is premultiplied and sRGB-encoded like the wash texture.
 */

const STEP_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_state;
uniform float u_c2;
uniform float u_damp;
uniform float u_aspect;
uniform vec4 u_drop;
out vec4 o_state;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(u_state, 0) - 1;
  vec2 s = texelFetch(u_state, c, 0).rg;
  // Clamped neighbours: a reflecting edge, which the damping soon quiets.
  float l = texelFetch(u_state, clamp(c + ivec2(1, 0), ivec2(0), last), 0).r
    + texelFetch(u_state, clamp(c - ivec2(1, 0), ivec2(0), last), 0).r
    + texelFetch(u_state, clamp(c + ivec2(0, 1), ivec2(0), last), 0).r
    + texelFetch(u_state, clamp(c - ivec2(0, 1), ivec2(0), last), 0).r
    - 4.0 * s.r;
  float h = (2.0 * s.r - s.g + u_c2 * l) * u_damp;
  // The drop lands on both heights: a displacement at rest, not a kick. Added
  // to the new height alone it would read as an upward velocity, and the
  // bump would keep rising to several times its size before it spread.
  float drop = 0.0;
  if (u_drop.z != 0.0) {
    vec2 d = (v_uv - u_drop.xy) * vec2(u_aspect, 1.0);
    drop = u_drop.z * exp(-dot(d, d) / (u_drop.w * u_drop.w));
  }
  o_state = vec4(h + drop, s.r + drop, 0.0, 1.0);
}
`

const PRESENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
${COVER_LAYER_GLSL}
uniform sampler2D u_height;
uniform vec2 u_simTexel;
uniform float u_aspect;
uniform float u_refract;
uniform float u_highlight;
uniform float u_highlightMax;
uniform vec3 u_light;
uniform float u_present;
out vec4 o_colour;

// Crests facing up and to the left catch the light.
const vec2 LIGHT = vec2(-0.5, 0.866);

void main() {
  vec2 lod = coverLod(v_uv);
  if (u_refract <= 0.0 && u_detail <= 0.0) {
    o_colour = texture(u_wash, v_uv);
    return;
  }
  vec2 tx = vec2(u_simTexel.x, 0.0);
  vec2 ty = vec2(0.0, u_simTexel.y);
  // Height difference per grid cell, central.
  vec2 slope = 0.5 * vec2(
    texture(u_height, v_uv + tx).r - texture(u_height, v_uv - tx).r,
    texture(u_height, v_uv + ty).r - texture(u_height, v_uv - ty).r
  );
  vec2 uv = v_uv + slope * u_refract / vec2(u_aspect, 1.0);
  vec4 colour = image(uv, lod);
  float light = clamp(dot(slope, LIGHT) * u_highlight, 0.0, u_highlightMax);
  colour.rgb += u_light * light * colour.a;
  colour = clamp(colour, 0.0, 1.0);
  colour.rgb = min(colour.rgb, vec3(colour.a));
  o_colour = mix(texture(u_wash, v_uv), colour, u_present);
}
`

const STEP_UNIFORMS = ['u_state', 'u_c2', 'u_damp', 'u_aspect', 'u_drop'] as const
const PRESENT_UNIFORMS = [
  ...COVER_LAYER_UNIFORMS,
  'u_height',
  'u_simTexel',
  'u_aspect',
  'u_refract',
  'u_highlight',
  'u_highlightMax',
  'u_light',
  'u_present'
] as const

/** Texture units, fixed for the effect's life. */
const UNIT_STATE = 0
const UNIT_WASH = 1
const UNIT_COVER = 2
const UNIT_COVER_PREVIOUS = 3

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Rainfall draws on a WebGL2 surface')
  const gl = target.context
  const step = compileProgram(gl, STEP_SHADER, 'Rainfall step')
  let present: WebGLProgram
  try {
    present = compileProgram(gl, PRESENT_SHADER, 'Rainfall present')
  } catch (error) {
    gl.deleteProgram(step)
    throw error
  }
  let state: PingPong
  let grid = simSize(1)
  try {
    state = createPingPong(gl, grid.cols, grid.rows, 'rg16f')
  } catch (error) {
    gl.deleteProgram(step)
    gl.deleteProgram(present)
    throw error
  }
  const s = uniformLocations(gl, step, STEP_UNIFORMS)
  const u = uniformLocations(gl, present, PRESENT_UNIFORMS)
  const triangle = createFullscreenTriangle(gl)
  const model = createRainfallModel()
  const layer = createCoverLayer(gl, u, {
    wash: UNIT_WASH,
    cover: UNIT_COVER,
    coverPrevious: UNIT_COVER_PREVIOUS
  })
  const light = new Float32Array(3)
  let lightVersion = -1

  gl.useProgram(step)
  gl.uniform1i(s.u_state, UNIT_STATE)
  gl.uniform1f(s.u_c2, WAVE_C2)
  gl.uniform1f(s.u_damp, model.damp)
  gl.useProgram(present)
  gl.uniform1i(u.u_height, UNIT_STATE)
  gl.useProgram(null)

  let width = 1
  let height = 1

  function bind(unit: number, texture: WebGLTexture | null): void {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  /** A flat, still surface. */
  function clearState(): void {
    gl.clearColor(0, 0, 0, 0)
    state.read.bind()
    gl.clear(gl.COLOR_BUFFER_BIT)
    state.write.bind()
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    model.reset()
  }
  clearState()

  function updateLight(palette: Palette): void {
    if (palette.version === lightVersion) return
    lightVersion = palette.version
    for (let channel = 0; channel < 3; channel++) {
      light[channel] = gammaEncode(palette.linear[PaletteSlot.textHighlighted * 3 + channel])
    }
  }

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
      const next = simSize(width / height)
      if (next.cols !== grid.cols || next.rows !== grid.rows) {
        grid = next
        state.resize(grid.cols, grid.rows)
        // The contents are undefined after a reallocation.
        clearState()
      }
    },

    frame(audio, palette, stage, dtSec) {
      const wash = stage.wash?.source
      if (!wash || !(wash instanceof WebGLTexture)) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        return
      }
      updateLight(palette)
      const aspect = width / height
      const steps = model.advance(dtSec)
      const params = model.update(
        audio,
        stage.emergence,
        stage.intensity,
        layer.washOpacity(stage),
        dtSec
      )

      // 1. Step the surface.
      if (steps > 0) {
        gl.useProgram(step)
        gl.uniform1f(s.u_aspect, grid.cols / grid.rows)
        const drop = model.drop
        for (let i = 0; i < steps; i++) {
          state.write.bind()
          bind(UNIT_STATE, state.read.texture)
          gl.uniform4f(s.u_drop, drop.u, drop.v, i === 0 ? drop.amplitude : 0, drop.sigma)
          triangle.draw()
          state.swap()
        }
        model.consumeDrop()
        bind(UNIT_STATE, null)
      }

      // 2. Present: the refracted image over the wash.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.useProgram(present)
      bind(UNIT_STATE, state.read.texture)
      layer.apply(stage, wash, aspect, params.detail, params.opacity, params.lodBias)
      gl.uniform2f(u.u_simTexel, 1 / grid.cols, 1 / grid.rows)
      gl.uniform1f(u.u_aspect, aspect)
      gl.uniform1f(u.u_refract, params.refract)
      gl.uniform1f(u.u_highlight, params.highlight)
      gl.uniform1f(u.u_highlightMax, params.highlightMax)
      gl.uniform3fv(u.u_light, light)
      gl.uniform1f(u.u_present, params.present)
      triangle.draw()

      // Leave no rendered texture bound, so nothing can sample the next write target.
      bind(UNIT_STATE, null)
      layer.unbind()
      gl.activeTexture(gl.TEXTURE0)
    },

    dispose() {
      state.dispose()
      triangle.dispose()
      gl.deleteProgram(step)
      gl.deleteProgram(present)
    }
  }
}

/** W23-11: ripples over the cover, one ring per onset. */
export const RAINFALL: VisualizerEffect = {
  id: 'rainfall',
  label: 'Rainfall',
  surface: 'webgl2',
  needs: { cover: true },
  emergence: 'grow',
  create
}
