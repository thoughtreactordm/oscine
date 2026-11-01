import { coverUvTransform } from '../coverFit'
import type { StageCoverSlot } from '../coverDecode'
import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, createFullscreenTriangle, uniformLocations } from '../gl/program'
import { saturateMatrix } from '../wash'
import { createDrive } from './drive'
import { createPlumageModel, detailLodFloor, PLUMAGE_KNOBS } from './plumageModel'

/**
 * **Plumage**: the stage's own cover starts to move (W23-10, D35.9, D35.11,
 * D35.12). This is the headline cover effect.
 *
 * It runs in one full-screen pass at the host's internal resolution, straight
 * into the default framebuffer. It needs no feedback and no targets of its own,
 * so it is the cheapest of the GPU effects. Each pixel does the following:
 *
 * - It folds its position through a mirrored kaleidoscope. The segment count
 *   and rotation follow the slow level, and a count change eases by blending
 *   two folds, so a seam never appears.
 * - It displaces that position with three octaves of smooth noise. The bass
 *   moves large regions, the mids medium ones, and the treble adds a fine
 *   shimmer.
 * - It samples the wash at the moved position, then the cover's own detail
 *   (current and previous, by `cover.mix`). The cover is read from a mip no
 *   finer than the blur floor, re-encoded to sRGB and saturated with the
 *   wash's own matrix, so it reads as the wash coming into focus rather than
 *   a sharp image pasted on. The cover is never shown sharp at full size.
 * - It mixes the cover layer in over the moved wash by emergence, then
 *   presents the result over the unmoved wash by the flash guard's intensity
 *   (D35.8).
 * - On an onset, it samples red and blue a little apart along the radius (the
 *   chromatic split). The split's envelope is the guard's minimum attack, and
 *   it is scaled by intensity and emergence.
 *
 * At emergence 0 every term adds exactly zero and the cover and split branches
 * are skipped, so the output is `texture(u_wash, v_uv)`: Plumage there *is* the
 * wash. Track changes crossfade inside the effect: the wash runs the host's
 * crossfade, and the cover layer mixes `previous` into `current` by the same
 * `mix`.
 *
 * Output is premultiplied and sRGB-encoded, like the wash texture, so the
 * host's handoff opacity applies unchanged.
 */

const SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_wash;
uniform sampler2D u_cover;
uniform sampler2D u_coverPrevious;
uniform float u_aspect;
uniform float u_detail;
uniform float u_opacity;
uniform float u_lodBias;
uniform vec2 u_lodFloor;
uniform vec4 u_coverUv;
uniform vec4 u_coverPreviousUv;
uniform float u_coverMix;
uniform mat3 u_saturate;
uniform float u_displaceLow;
uniform float u_displaceMid;
uniform float u_displaceHigh;
uniform float u_lowPhase;
uniform float u_highPhase;
uniform float u_kaleido;
uniform vec3 u_segments;
uniform float u_rotation;
uniform float u_split;
uniform float u_present;
out vec4 o_colour;

const float TAU = 6.28318530718;
const float QUARTER = 1.57079632679;

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Value noise with a quintic fade, -1..1: smooth enough that its gradient never kinks.
float noise(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

vec2 field(vec2 q, float frequency, float phase, float offset) {
  vec2 s = q * frequency + offset;
  return vec2(noise(s + vec2(phase, 0.0)), noise(s + vec2(41.7, 13.1 - phase * 0.9)));
}

// The mirrored fold (plumageModel.foldAngle): a triangle wave in angle, so
// continuous everywhere for an integer count. Its source wedge points up.
vec2 fold(vec2 p, float segments) {
  // atan(0, 0) is undefined, and a NaN times a zero kaleido share is still NaN.
  if (dot(p, p) < 1e-12) return p;
  float period = TAU / segments;
  float a = atan(p.y, p.x) + u_rotation;
  float t = a - period * floor(a / period);
  t = min(t, period - t) + QUARTER - period * 0.25;
  return length(p) * vec2(cos(t), sin(t));
}

vec4 coverTaps(sampler2D cover, vec2 uv, float lod) {
  // Four taps on a rotated grid half a texel apart at that mip: smooths the
  // bilinear diamonds a magnified mip otherwise shows.
  vec2 texel = exp2(lod) / vec2(textureSize(cover, 0));
  vec2 a = texel * vec2(0.35, 0.15);
  vec2 b = texel * vec2(-0.15, 0.35);
  vec4 c = textureLod(cover, uv + a, lod) + textureLod(cover, uv - a, lod)
    + textureLod(cover, uv + b, lod) + textureLod(cover, uv - b, lod);
  return c * 0.25;
}

vec4 shade(vec4 linear) {
  vec3 rgb = encode(linear.rgb);
  rgb = clamp(u_saturate * rgb, 0.0, 1.0);
  float alpha = linear.a * u_opacity;
  return vec4(rgb * alpha, alpha);
}

// The image at a moved screen UV: the moved wash, with the cover's detail mixed in.
vec4 image(vec2 uv, vec2 lod) {
  vec4 colour = texture(u_wash, uv);
  if (u_detail > 0.0) {
    vec4 current = coverTaps(u_cover, uv * u_coverUv.xy + u_coverUv.zw, lod.x);
    if (u_coverMix < 1.0) {
      vec4 previous = coverTaps(u_coverPrevious, uv * u_coverPreviousUv.xy + u_coverPreviousUv.zw, lod.y);
      current = mix(previous, current, u_coverMix);
    }
    colour = mix(colour, shade(current), u_detail);
  }
  return colour;
}

float derivativeLod(vec2 coverUv, sampler2D cover) {
  vec2 size = vec2(textureSize(cover, 0));
  vec2 dx = dFdx(coverUv) * size;
  vec2 dy = dFdy(coverUv) * size;
  return 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
}

void main() {
  vec2 scale = vec2(u_aspect, 1.0);
  vec2 p = (v_uv - 0.5) * scale;

  vec2 folded = mix(fold(p, u_segments.x), fold(p, u_segments.y), u_segments.z);
  vec2 q = mix(p, folded, u_kaleido);
  q += field(q, 1.4, u_lowPhase, 0.0) * u_displaceLow;
  q += field(q, 4.2, u_lowPhase * 1.7, 7.3) * u_displaceMid;
  q += field(q, 15.0, u_highPhase, 19.1) * u_displaceHigh;
  // Added as a difference, so at emergence 0 the UV is v_uv bit for bit.
  vec2 uv = v_uv + (q - p) / scale;

  // Derivatives before any branch. The floor keeps the cover soft, and the
  // derivative keeps a squeezed fold from aliasing.
  vec2 lod = vec2(
    max(u_lodFloor.x + u_lodBias, derivativeLod(uv * u_coverUv.xy, u_cover)),
    max(u_lodFloor.y + u_lodBias, derivativeLod(uv * u_coverPreviousUv.xy, u_coverPrevious))
  );

  vec4 colour;
  if (u_split > 0.0) {
    float r = length(p);
    vec2 offset = (r > 1e-4 ? p / r : vec2(0.0)) * smoothstep(0.0, 0.15, r) * u_split / scale;
    vec4 red = image(uv + offset, lod);
    vec4 green = image(uv, lod);
    vec4 blue = image(uv - offset, lod);
    float alpha = max(green.a, max(red.a, blue.a));
    colour = vec4(red.r, green.g, blue.b, alpha);
  } else {
    colour = image(uv, lod);
  }
  colour = clamp(colour, 0.0, 1.0);
  colour.rgb = min(colour.rgb, vec3(colour.a));
  o_colour = mix(texture(u_wash, v_uv), colour, u_present);
}
`

const UNIFORMS = [
  'u_wash',
  'u_cover',
  'u_coverPrevious',
  'u_aspect',
  'u_detail',
  'u_opacity',
  'u_lodBias',
  'u_lodFloor',
  'u_coverUv',
  'u_coverPreviousUv',
  'u_coverMix',
  'u_saturate',
  'u_displaceLow',
  'u_displaceMid',
  'u_displaceHigh',
  'u_lowPhase',
  'u_highPhase',
  'u_kaleido',
  'u_segments',
  'u_rotation',
  'u_split',
  'u_present'
] as const

const UNIT_WASH = 0
const UNIT_COVER = 1
const UNIT_COVER_PREVIOUS = 2

/** Used until the host's look arrives; the stage's defaults (D35.12). */
const FALLBACK_OPACITY = 0.2
const FALLBACK_SATURATE = 2.2
const FALLBACK_SCALE = 1.25

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Plumage draws on a WebGL2 surface')
  const gl = target.context
  const program = compileProgram(gl, SHADER, 'Plumage')
  const u = uniformLocations(gl, program, UNIFORMS)
  const triangle = createFullscreenTriangle(gl)
  const model = createPlumageModel(target.params)
  const drive = createDrive()
  const coverUv = new Float32Array(4)
  const previousUv = new Float32Array(4)
  let saturate = new Float32Array(saturateMatrix(FALLBACK_SATURATE))
  let saturateAmount = FALLBACK_SATURATE

  gl.useProgram(program)
  gl.uniform1i(u.u_wash, UNIT_WASH)
  gl.uniform1i(u.u_cover, UNIT_COVER)
  gl.uniform1i(u.u_coverPrevious, UNIT_COVER_PREVIOUS)
  gl.useProgram(null)

  let width = 1
  let height = 1

  function bind(unit: number, texture: WebGLTexture | null): void {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  /** Fit `slot` into `out` and return its LOD floor. */
  function fit(slot: StageCoverSlot, aspect: number, scale: number, out: Float32Array): number {
    coverUvTransform(slot.aspect, aspect, scale, out)
    return detailLodFloor(slot.bitmap.height, out[1])
  }

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
    },

    frame(audio, palette, stage, dtSec) {
      void palette
      const wash = stage.wash?.source
      if (!wash || !(wash instanceof WebGLTexture)) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        return
      }
      const look = stage.wash?.look ?? null
      const washOpacity = look?.opacity ?? FALLBACK_OPACITY
      const washScale = look?.scale ?? FALLBACK_SCALE
      const amount = look?.saturate ?? FALLBACK_SATURATE
      if (amount !== saturateAmount) {
        saturateAmount = amount
        saturate = new Float32Array(saturateMatrix(amount))
      }

      drive.update(audio, dtSec)
      const params = model.update(
        audio,
        drive,
        stage.emergence,
        stage.intensity,
        washOpacity,
        dtSec
      )

      const aspect = width / height
      const cover = stage.cover
      const current = cover?.current.texture ?? null
      const previous = cover?.previous?.texture ?? null
      // Without a texture there is no cover layer, only the moved wash.
      const detail = current ? params.detail : 0
      let floor = 0
      let previousFloor = 0
      if (cover && current) floor = fit(cover.current, aspect, washScale, coverUv)
      const crossfading = !!(cover?.previous && previous)
      if (crossfading && cover?.previous) {
        previousFloor = fit(cover.previous, aspect, washScale, previousUv)
      }

      gl.useProgram(program)
      bind(UNIT_WASH, wash)
      bind(UNIT_COVER, current)
      bind(UNIT_COVER_PREVIOUS, crossfading ? previous : current)
      gl.uniform1f(u.u_aspect, aspect)
      gl.uniform1f(u.u_detail, detail)
      gl.uniform1f(u.u_opacity, params.opacity)
      gl.uniform1f(u.u_lodBias, params.lodBias)
      gl.uniform2f(u.u_lodFloor, floor, crossfading ? previousFloor : floor)
      gl.uniform4fv(u.u_coverUv, coverUv)
      gl.uniform4fv(u.u_coverPreviousUv, crossfading ? previousUv : coverUv)
      gl.uniform1f(u.u_coverMix, crossfading ? (cover?.mix ?? 1) : 1)
      gl.uniformMatrix3fv(u.u_saturate, true, saturate)
      gl.uniform1f(u.u_displaceLow, params.displaceLow)
      gl.uniform1f(u.u_displaceMid, params.displaceMid)
      gl.uniform1f(u.u_displaceHigh, params.displaceHigh)
      gl.uniform1f(u.u_lowPhase, params.lowPhase)
      gl.uniform1f(u.u_highPhase, params.highPhase)
      gl.uniform1f(u.u_kaleido, params.kaleido)
      gl.uniform3f(u.u_segments, params.segmentsA, params.segmentsB, params.segmentBlend)
      gl.uniform1f(u.u_rotation, params.rotation)
      gl.uniform1f(u.u_split, params.split)
      gl.uniform1f(u.u_present, params.present)
      triangle.draw()

      bind(UNIT_COVER, null)
      bind(UNIT_COVER_PREVIOUS, null)
      bind(UNIT_WASH, null)
    },

    dispose() {
      triangle.dispose()
      gl.deleteProgram(program)
    }
  }
}

/** W23-10: the cover, displaced and kaleidoscoped. */
export const PLUMAGE: VisualizerEffect = {
  id: 'plumage',
  label: 'Plumage',
  surface: 'webgl2',
  needs: { cover: true },
  emergence: 'grow',
  params: PLUMAGE_KNOBS,
  create
}
