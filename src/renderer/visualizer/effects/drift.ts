import { coverUvTransform } from '../coverFit'
import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, createFullscreenTriangle, uniformLocations } from '../gl/program'
import { createPingPong, type PingPong } from '../gl/target'
import { createDrive } from './drive'
import { createDriftModel, RING_COVER_SHARE, RING_WIDTH, RING_WIDTH_MIN_PX } from './driftModel'
import { createWaveformReader } from './waveform'

/**
 * **Drift** — the cover-seeded feedback field (W23-9, D35.9, D35.12). The
 * effect that gives the old-WMP feel, and the reason the GPU tier exists:
 * per-pixel feedback at full-stage size.
 *
 * Two passes a frame, both full-screen triangles at the host's internal
 * resolution (D35.6 — never the box's native size):
 *
 * 1. **Update**, into the ping-pong's `write`: sample the last field through
 *    the warp (zoom on bass, spin on mid, turbulence on treble), decay it
 *    towards the darker ramp steps, mix in the waveform as a ring, and re-seed
 *    from the wash. The maths and every rate are in `driftModel.ts`.
 * 2. **Present**, into the default framebuffer: the field over the wash by the
 *    flash guard's intensity (D35.8), so a clamp falls back to the stage's own
 *    rest state rather than to black.
 *
 * At emergence 0 the update writes the wash texel for texel (keep = 0, no
 * dither) and the present copies it, so Drift there *is* the wash (D35.12).
 * The field is premultiplied and sRGB-encoded like the wash texture, so the
 * host's handoff opacity applies unchanged.
 *
 * The field is `RGBA8`. Feedback in 8 bits stalls — a mix whose step is under
 * half a code value rounds to nothing, which is what leaves ghosts — so the
 * update dithers by one code value, and the expected value then converges
 * where the maths says it should.
 */

const WAVE_POINTS = 256

const UPDATE_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_wash;
uniform sampler2D u_cover;
uniform sampler2D u_coverPrevious;
uniform sampler2D u_wave;
uniform float u_aspect;
uniform float u_keep;
uniform float u_decay;
uniform float u_zoom;
uniform float u_spin;
uniform float u_twist;
uniform float u_turbulence;
uniform float u_turbulencePhase;
uniform float u_ringRadius;
uniform float u_ringAmplitude;
uniform float u_ringAlpha;
uniform float u_ringWidth;
uniform float u_beat;
uniform float u_coverShare;
uniform float u_coverMix;
uniform vec4 u_coverUv;
uniform vec4 u_coverPreviousUv;
uniform vec3 u_darkA;
uniform vec3 u_darkB;
uniform vec3 u_ring;
uniform vec3 u_ringBeat;
uniform float u_dither;
uniform float u_seed;
out vec4 o_colour;

const float TAU = 6.28318530718;
const int WAVE_POINTS = ${WAVE_POINTS};

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float wave(float t) {
  float x = t * float(WAVE_POINTS - 1);
  int i = clamp(int(floor(x)), 0, WAVE_POINTS - 1);
  int j = min(i + 1, WAVE_POINTS - 1);
  float a = texelFetch(u_wave, ivec2(i, 0), 0).r;
  float b = texelFetch(u_wave, ivec2(j, 0), 0).r;
  return mix(a, b, fract(x));
}

void main() {
  vec4 wash = texture(u_wash, v_uv);
  vec2 p = (v_uv - 0.5) * vec2(u_aspect, 1.0);
  float r = length(p);

  // Where this pixel's content was a frame ago: rotated back, nearer the centre.
  float angle = u_spin + u_twist * r;
  float c = cos(angle);
  float s = sin(angle);
  vec2 q = mat2(c, -s, s, c) * p / u_zoom;
  float phase = u_turbulencePhase * TAU;
  q += u_turbulence * vec2(sin(q.y * 9.0 + phase), cos(q.x * 9.0 - phase * 0.8));
  q += u_turbulence * 0.5 * vec2(sin(q.y * 23.0 - phase * 0.5), cos(q.x * 21.0 + phase * 0.9));
  vec2 from = q / vec2(u_aspect, 1.0) + 0.5;
  bool inside = all(greaterThanEqual(from, vec2(0.0))) && all(lessThanEqual(from, vec2(1.0)));
  vec4 warped = inside ? texture(u_field, from) : wash;

  // Decay towards the darker ramp steps, darkest at the rim.
  vec3 dark = mix(u_darkA, u_darkB, smoothstep(0.05, 0.75, r));
  warped = mix(warped, vec4(dark, 1.0), u_decay);

  // The waveform as a closed ring (the reader tapers its ends, so no seam).
  float t = atan(p.y, p.x) / TAU + 0.5;
  float d = abs(r - (u_ringRadius + wave(t) * u_ringAmplitude));
  float mask = 1.0 - smoothstep(u_ringWidth * 0.4, u_ringWidth, d);
  vec3 cover = mix(
    texture(u_coverPrevious, v_uv * u_coverPreviousUv.xy + u_coverPreviousUv.zw).rgb,
    texture(u_cover, v_uv * u_coverUv.xy + u_coverUv.zw).rgb,
    u_coverMix
  );
  vec3 ring = mix(mix(u_ring, u_ringBeat, u_beat), encode(cover), u_coverShare);
  warped = mix(warped, vec4(ring, 1.0), u_ringAlpha * mask);

  vec4 field = mix(wash, warped, u_keep);
  vec2 cell = gl_FragCoord.xy + u_seed;
  field += (hash(cell) + hash(cell + 71.7) - 1.0) * u_dither / 255.0;
  field = clamp(field, 0.0, 1.0);
  field.rgb = min(field.rgb, vec3(field.a));
  o_colour = field;
}
`

const PRESENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_field;
uniform sampler2D u_wash;
uniform float u_present;
out vec4 o_colour;
void main() {
  o_colour = mix(texture(u_wash, v_uv), texture(u_field, v_uv), u_present);
}
`

const UPDATE_UNIFORMS = [
  'u_field',
  'u_wash',
  'u_cover',
  'u_coverPrevious',
  'u_wave',
  'u_aspect',
  'u_keep',
  'u_decay',
  'u_zoom',
  'u_spin',
  'u_twist',
  'u_turbulence',
  'u_turbulencePhase',
  'u_ringRadius',
  'u_ringAmplitude',
  'u_ringAlpha',
  'u_ringWidth',
  'u_beat',
  'u_coverShare',
  'u_coverMix',
  'u_coverUv',
  'u_coverPreviousUv',
  'u_darkA',
  'u_darkB',
  'u_ring',
  'u_ringBeat',
  'u_dither',
  'u_seed'
] as const

/** Texture units, fixed for the effect's life. */
const UNIT_FIELD = 0
const UNIT_WASH = 1
const UNIT_COVER = 2
const UNIT_COVER_PREVIOUS = 3
const UNIT_WAVE = 4

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Drift draws on a WebGL2 surface')
  const gl = target.context
  const update = compileProgram(gl, UPDATE_SHADER, 'Drift update')
  let present: WebGLProgram
  try {
    present = compileProgram(gl, PRESENT_SHADER, 'Drift present')
  } catch (error) {
    gl.deleteProgram(update)
    throw error
  }
  const u = uniformLocations(gl, update, UPDATE_UNIFORMS)
  const p = uniformLocations(gl, present, ['u_field', 'u_wash', 'u_present'])
  const triangle = createFullscreenTriangle(gl)
  const model = createDriftModel()
  const drive = createDrive()
  const reader = createWaveformReader(WAVE_POINTS)
  const coverUv = new Float32Array(4)
  const previousUv = new Float32Array(4)

  const waveTexture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, waveTexture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, WAVE_POINTS, 1, 0, gl.RED, gl.FLOAT, reader.points)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, null)

  // Samplers never change unit.
  gl.useProgram(update)
  gl.uniform1i(u.u_field, UNIT_FIELD)
  gl.uniform1i(u.u_wash, UNIT_WASH)
  gl.uniform1i(u.u_cover, UNIT_COVER)
  gl.uniform1i(u.u_coverPrevious, UNIT_COVER_PREVIOUS)
  gl.uniform1i(u.u_wave, UNIT_WAVE)
  gl.useProgram(present)
  gl.uniform1i(p.u_field, UNIT_FIELD)
  gl.uniform1i(p.u_wash, UNIT_WASH)
  gl.useProgram(null)

  let field: PingPong | null = null
  let width = 1
  let height = 1
  let seed = 0

  function bind(unit: number, texture: WebGLTexture | null): void {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
      if (field) field.resize(width, height)
      else field = createPingPong(gl, width, height)
      // The contents are undefined after a reallocation: start again from the wash.
      model.reseed()
    },

    frame(audio, palette, stage, dtSec) {
      const wash = stage.wash?.source
      if (!field || !wash || !(wash instanceof WebGLTexture)) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        return
      }

      drive.update(audio, dtSec)
      reader.read(audio.waveform, dtSec)
      const params = model.update(audio, drive, stage.emergence, stage.intensity, dtSec)
      const colours = model.updateColours(palette)

      const aspect = width / height
      const cover = stage.cover
      const current = cover?.current.texture ?? null
      const previous = cover?.previous?.texture ?? null
      const coverShare = current ? RING_COVER_SHARE : 0
      if (cover && current) coverUvTransform(cover.current.aspect, aspect, 1, coverUv)
      if (cover?.previous && previous) {
        coverUvTransform(cover.previous.aspect, aspect, 1, previousUv)
      }

      gl.bindTexture(gl.TEXTURE_2D, waveTexture)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WAVE_POINTS, 1, gl.RED, gl.FLOAT, reader.points)

      // 1. Update: last field → this one.
      field.write.bind()
      gl.useProgram(update)
      bind(UNIT_FIELD, field.read.texture)
      bind(UNIT_WASH, wash)
      bind(UNIT_COVER, current)
      bind(UNIT_COVER_PREVIOUS, previous ?? current)
      bind(UNIT_WAVE, waveTexture)
      gl.uniform1f(u.u_aspect, aspect)
      gl.uniform1f(u.u_keep, params.keep)
      gl.uniform1f(u.u_decay, params.decay)
      gl.uniform1f(u.u_zoom, params.zoom)
      gl.uniform1f(u.u_spin, params.spin)
      gl.uniform1f(u.u_twist, params.twist)
      gl.uniform1f(u.u_turbulence, params.turbulence)
      gl.uniform1f(u.u_turbulencePhase, params.turbulencePhase)
      gl.uniform1f(u.u_ringRadius, params.ringRadius)
      gl.uniform1f(u.u_ringAmplitude, params.ringAmplitude)
      gl.uniform1f(u.u_ringAlpha, params.ringAlpha)
      gl.uniform1f(u.u_ringWidth, Math.max(RING_WIDTH, RING_WIDTH_MIN_PX / height))
      gl.uniform1f(u.u_beat, drive.pulse)
      gl.uniform1f(u.u_coverShare, coverShare)
      gl.uniform1f(u.u_coverMix, previous ? (cover?.mix ?? 1) : 1)
      gl.uniform4fv(u.u_coverUv, coverUv)
      gl.uniform4fv(u.u_coverPreviousUv, previous ? previousUv : coverUv)
      gl.uniform3fv(u.u_darkA, colours.darkA)
      gl.uniform3fv(u.u_darkB, colours.darkB)
      gl.uniform3fv(u.u_ring, colours.ring)
      gl.uniform3fv(u.u_ringBeat, colours.ringBeat)
      gl.uniform1f(u.u_dither, params.dither)
      seed = (seed + 1) % 4096
      gl.uniform1f(u.u_seed, seed * 7.31)
      triangle.draw()
      field.swap()

      // 2. Present: the field over the wash by the flash guard's intensity.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.useProgram(present)
      bind(UNIT_FIELD, field.read.texture)
      bind(UNIT_WASH, wash)
      gl.uniform1f(p.u_present, params.present)
      triangle.draw()

      // Leave no rendered texture bound, so nothing can sample the next write target.
      bind(UNIT_FIELD, null)
      bind(UNIT_COVER, null)
      bind(UNIT_COVER_PREVIOUS, null)
      gl.activeTexture(gl.TEXTURE0)
    },

    dispose() {
      field?.dispose()
      field = null
      gl.deleteTexture(waveTexture)
      triangle.dispose()
      gl.deleteProgram(update)
      gl.deleteProgram(present)
    }
  }
}

/** W23-9: the cover-seeded feedback field. */
export const DRIFT: VisualizerEffect = {
  id: 'drift',
  label: 'Drift',
  surface: 'webgl2',
  needs: { cover: true },
  emergence: 'grow',
  create
}
