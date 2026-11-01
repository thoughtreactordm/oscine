import { coverUvTransform } from '../coverFit'
import type { StageCoverSlot } from '../coverDecode'
import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, uniformLocations } from '../gl/program'
import { PaletteSlot, type Palette } from '../palette'
import { createMurmurationModel, MAX_PARTICLES, particleCount } from './murmurationModel'

/**
 * **Murmuration**: a flock of a few thousand particles in the cover's colours,
 * flying over the wash (W23-12, D35.9, D35.11). It's an `overlay` effect, so
 * the host fades it in by emergence and keeps the wash under it at
 * `washUnder` 1.
 *
 * Particle state lives in two GPU buffers that take turns (transform feedback
 * needs no float-renderable extension, so it runs wherever the tier does).
 * Each particle is ten floats, interleaved:
 *
 * - `state`: position and velocity, in stage units (x in ±aspect/2, y in ±0.5,
 *   y up; stage heights a second);
 * - `colour`: sRGB-encoded RGB, fixed at birth; the fourth float is unused;
 * - `life`: age and lifespan, seconds.
 *
 * Two passes a frame:
 *
 * 1. **Update**, a vertex shader under `RASTERIZER_DISCARD`, captured into the
 *    other buffer. A particle steers its velocity towards the curl-noise flow
 *    at the bass-driven speed. The flock boundary pulls it back once it is
 *    outside, and the onset scatter pushes it away from the scatter point
 *    (all in `murmurationModel.ts`). A particle that has outlived its span or
 *    left the stage is reborn. It takes the colour of the cover pixel under
 *    its birthplace, read from a small mip, so the cover's hues come through
 *    without a palette extractor. A new track's colours spread through the
 *    flock as particles are reborn, rather than snapping.
 * 2. **Render**: one instanced quad per particle, read straight from the
 *    buffer just written, stretched along the velocity into a soft streak.
 *    Blended premultiplied "over" onto a cleared, transparent canvas, and
 *    multiplied by the flash guard's intensity (D35.8).
 *
 * Nothing per particle touches the CPU after creation.
 */

/** Floats per particle: state (4), colour (4), life (2). */
const FLOATS = 10
const STRIDE = FLOATS * 4

const NOISE_GLSL = `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec3 random3(uvec3 seed) {
  return vec3(pcg3d(seed)) * (1.0 / 4294967296.0);
}

vec3 gradient(ivec3 cell) {
  return random3(uvec3(cell)) * 2.0 - 1.0;
}

// 3-D gradient noise with a quintic fade, so its derivative (the flow) is smooth.
float noise(vec3 p) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(gradient(i), f);
  float n100 = dot(gradient(i + ivec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(gradient(i + ivec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(gradient(i + ivec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(gradient(i + ivec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(gradient(i + ivec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(gradient(i + ivec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(gradient(i + ivec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(
    mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
    mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y),
    w.z
  );
}
`

const UPDATE_SHADER = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_state;
layout(location = 1) in vec4 a_colour;
layout(location = 2) in vec2 a_life;
uniform float u_dt;
uniform float u_time;
uniform uint u_frame;
uniform float u_aspect;
uniform float u_speed;
uniform vec4 u_flock;
uniform float u_angle;
uniform vec3 u_scatter;
uniform sampler2D u_cover;
uniform sampler2D u_coverPrevious;
uniform vec4 u_coverUv;
uniform vec4 u_coverPreviousUv;
uniform float u_coverLod;
uniform float u_coverPreviousLod;
uniform float u_coverMix;
uniform int u_hasCover;
uniform int u_hasPrevious;
uniform vec3 u_swatches[16];
uniform vec3 u_fallback;
out vec4 v_state;
out vec4 v_colour;
out vec2 v_life;

${NOISE_GLSL}

// Field scale (cycles per stage height) and how fast it evolves.
const float FREQ = 1.6;
const float EVOLVE = 0.07;
// A curl of this noise runs about FREQ·1.3 at its typical peak; this brings it near 1.
const float FLOW_NORM = 1.0 / (FREQ * 1.3);
// How quickly a particle's velocity settles onto the flow, seconds.
const float VELOCITY_TAU = 0.4;
// Cohesion: a soft pull towards the centre everywhere (so the cloud is
// densest in the middle rather than piling up on its edge), and a stiffer one
// past the boundary. Stage heights per second squared, per unit of radius.
const float COHESION = 0.55;
const float BOUNDARY_K = 1.6;
const float BOUNDARY_MAX = 2.0;
// How much the boundary slackens at full scatter.
const float SLACKEN = 0.85;
// The scatter's push at full strength, and its reach.
const float SCATTER_ACCEL = 2.6;
const float SCATTER_REACH = 0.26;
// A gentle turn about the centre, so the cloud wheels as well as churns.
const float SWIRL = 0.35;
// Lifespans, seconds: every particle is reborn within LIFE_MAX of a track change.
const float LIFE_MIN = 3.0;
const float LIFE_MAX = 9.0;
// The share of births anywhere on the stage, rather than inside the flock.
const float STRAGGLERS = 0.1;
// Colour treatment at birth, in linear light.
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float SATURATE = 1.3;
const float LIFT_Y = 0.12;

mat2 rotation(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, s, -s, c);
}

float potential(vec2 p, float t) {
  return noise(vec3(p * FREQ, t * EVOLVE))
    + 0.5 * noise(vec3(p * (FREQ * 2.1) + 17.0, t * (EVOLVE * 1.7)));
}

// Divergence-free: the curl of a scalar potential, so the flock neither
// bunches into sinks nor tears open at sources.
vec2 flow(vec2 p) {
  const float e = 0.01;
  float dx = potential(p + vec2(e, 0.0), u_time) - potential(p - vec2(e, 0.0), u_time);
  float dy = potential(p + vec2(0.0, e), u_time) - potential(p - vec2(0.0, e), u_time);
  vec2 curl = vec2(dy, -dx) / (2.0 * e) * FLOW_NORM;
  vec2 d = p - u_flock.xy;
  return curl + SWIRL * vec2(-d.y, d.x) / max(u_flock.z, u_flock.w);
}

vec3 sampleSlot(sampler2D cover, vec4 transform, float lod, vec2 uv) {
  return textureLod(cover, uv * transform.xy + transform.zw, lod).rgb;
}

// The cover's colour at a stage UV (y up), linear.
vec3 coverAt(vec2 uv) {
  if (u_hasCover == 0) {
    // No texture yet: the swatch grid, row-major from the top-left.
    ivec2 cell = clamp(ivec2(uv.x * 4.0, (1.0 - uv.y) * 4.0), ivec2(0), ivec2(3));
    return u_swatches[cell.y * 4 + cell.x];
  }
  vec3 colour = sampleSlot(u_cover, u_coverUv, u_coverLod, uv);
  if (u_hasPrevious == 1) {
    colour = mix(sampleSlot(u_coverPrevious, u_coverPreviousUv, u_coverPreviousLod, uv), colour, u_coverMix);
  }
  return colour;
}

// Saturated a little and lifted off black, so a particle reads against the
// wash it was sampled from. A black cover gives the palette's muted text.
vec3 style(vec3 c) {
  float y = dot(c, LUMA);
  vec3 styled = max(vec3(y) + (c - vec3(y)) * SATURATE, 0.0);
  styled *= clamp(LIFT_Y / max(dot(styled, LUMA), 1e-4), 1.0, 6.0);
  return mix(u_fallback, min(styled, 1.0), smoothstep(0.002, 0.01, y));
}

vec3 encode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 p = a_state.xy;
  vec2 v = a_state.zw;
  float age = a_life.x + u_dt;
  float life = a_life.y;
  vec3 colour = a_colour.rgb;
  vec2 halfStage = vec2(0.5 * u_aspect, 0.5);

  if (age >= life || any(greaterThan(abs(p), halfStage + 0.15))) {
    uint id = uint(gl_VertexID);
    vec3 r = random3(uvec3(id, u_frame, 0x9e3779b9u));
    vec3 s = random3(uvec3(id, u_frame, 0x85ebca6bu));
    if (s.y < STRAGGLERS) {
      p = (r.xy - 0.5) * vec2(u_aspect, 1.0);
    } else {
      float a = r.x * 6.2831853;
      p = u_flock.xy + rotation(u_angle) * (vec2(cos(a), sin(a)) * sqrt(r.y) * u_flock.zw);
    }
    v = flow(p) * u_speed;
    age = 0.0;
    life = mix(LIFE_MIN, LIFE_MAX, s.x);
    colour = encode(style(coverAt(p / vec2(u_aspect, 1.0) + 0.5)));
  } else {
    vec2 accel = (flow(p) * u_speed - v) / VELOCITY_TAU;
    vec2 d = p - u_flock.xy;
    float r = length(rotation(-u_angle) * d / u_flock.zw);
    if (r > 1e-4) {
      float pull = COHESION * r + BOUNDARY_K * clamp(r - 1.0, 0.0, BOUNDARY_MAX);
      accel -= normalize(d) * (pull * (1.0 - SLACKEN * u_scatter.z));
    }
    if (u_scatter.z > 0.0) {
      vec2 away = p - u_scatter.xy;
      float dist = length(away);
      float reach = exp(-(dist * dist) / (SCATTER_REACH * SCATTER_REACH));
      accel += away / max(dist, 1e-3) * (SCATTER_ACCEL * u_scatter.z * reach);
    }
    v += accel * u_dt;
    p += v * u_dt;
  }

  v_state = vec4(p, v);
  v_colour = vec4(colour, 1.0);
  v_life = vec2(age, life);
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
`

/** Never runs (the update draws under RASTERIZER_DISCARD); a program needs one to link. */
const UPDATE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
out vec4 o_colour;
void main() {
  o_colour = vec4(0.0);
}
`

const RENDER_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_state;
layout(location = 1) in vec4 a_colour;
layout(location = 2) in vec2 a_life;
uniform float u_aspect;
uniform float u_halfWidth;
uniform float u_minHalfWidth;
uniform float u_stretch;
uniform float u_alpha;
out vec2 v_local;
flat out vec4 v_colour;

const float FADE_IN = 0.8;
const float FADE_OUT = 1.2;

void main() {
  // Triangle strip corners: (-1,-1), (1,-1), (-1,1), (1,1).
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vec2 velocity = a_state.zw;
  float speed = length(velocity);
  vec2 along = speed > 1e-5 ? velocity / speed : vec2(1.0, 0.0);
  // Below a pixel or so the streak is drawn at the minimum and dimmed to match,
  // so a smaller target keeps the same coverage instead of aliasing.
  float width = max(u_halfWidth, u_minHalfWidth);
  float coverage = u_halfWidth / width;
  float length_ = width * (1.0 + u_stretch * speed);
  vec2 p = a_state.xy + along * (corner.x * length_) + vec2(-along.y, along.x) * (corner.y * width);
  gl_Position = vec4(p.x / (0.5 * u_aspect), p.y / 0.5, 0.0, 1.0);

  float age = a_life.x;
  float life = a_life.y;
  float fade = smoothstep(0.0, FADE_IN, age) * (1.0 - smoothstep(life - FADE_OUT, life, age));
  float alpha = u_alpha * fade * coverage;
  v_colour = vec4(a_colour.rgb * alpha, alpha);
  v_local = corner;
}
`

const RENDER_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 v_local;
flat in vec4 v_colour;
out vec4 o_colour;
void main() {
  o_colour = v_colour * (1.0 - smoothstep(0.35, 1.0, length(v_local)));
}
`

const UPDATE_UNIFORMS = [
  'u_dt',
  'u_time',
  'u_frame',
  'u_aspect',
  'u_speed',
  'u_flock',
  'u_angle',
  'u_scatter',
  'u_cover',
  'u_coverPrevious',
  'u_coverUv',
  'u_coverPreviousUv',
  'u_coverLod',
  'u_coverPreviousLod',
  'u_coverMix',
  'u_hasCover',
  'u_hasPrevious',
  'u_swatches',
  'u_fallback'
] as const
const RENDER_UNIFORMS = [
  'u_aspect',
  'u_halfWidth',
  'u_minHalfWidth',
  'u_stretch',
  'u_alpha'
] as const

/** A streak's half-width, stage heights (about 2 px at 1080p), and the floor in pixels. */
const HALF_WIDTH = 0.0018
const MIN_HALF_WIDTH_PX = 1
/** Length per unit speed: a streak at 0.3 stage heights a second is about 2.8 times its width. */
const STRETCH = 6
/** A particle's opacity at full fade-in. */
const ALPHA = 0.9
/** The colour sample's footprint: a mip about this many texels across the cover. */
const COVER_SAMPLE_TEXELS = 48

const UNIT_COVER = 0
const UNIT_COVER_PREVIOUS = 1

/** The mip level whose longer side is about {@link COVER_SAMPLE_TEXELS}. */
function coverLod(slot: StageCoverSlot): number {
  const size = Math.max(slot.bitmap.width, slot.bitmap.height)
  return size > COVER_SAMPLE_TEXELS ? Math.log2(size / COVER_SAMPLE_TEXELS) : 0
}

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Murmuration draws on a WebGL2 surface')
  const gl = target.context
  const update = compileProgram(gl, UPDATE_FRAGMENT_SHADER, 'Murmuration update', UPDATE_SHADER, [
    'v_state',
    'v_colour',
    'v_life'
  ])
  let render: WebGLProgram
  try {
    render = compileProgram(gl, RENDER_FRAGMENT_SHADER, 'Murmuration render', RENDER_VERTEX_SHADER)
  } catch (error) {
    gl.deleteProgram(update)
    throw error
  }
  const u = uniformLocations(gl, update, UPDATE_UNIFORMS)
  const r = uniformLocations(gl, render, RENDER_UNIFORMS)
  const model = createMurmurationModel()

  // Two particle buffers, zeroed: a zero lifespan means every particle is born
  // on the first update, coloured from whatever cover is up then.
  const buffers = [gl.createBuffer(), gl.createBuffer()]
  const updateVaos = [gl.createVertexArray(), gl.createVertexArray()]
  const renderVaos = [gl.createVertexArray(), gl.createVertexArray()]
  const feedback = gl.createTransformFeedback()
  for (let i = 0; i < 2; i++) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i])
    gl.bufferData(gl.ARRAY_BUFFER, MAX_PARTICLES * STRIDE, gl.DYNAMIC_COPY)
    for (const [vao, divisor] of [
      [updateVaos[i], 0],
      [renderVaos[i], 1]
    ] as const) {
      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[i])
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 16)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STRIDE, 32)
      gl.vertexAttribDivisor(0, divisor)
      gl.vertexAttribDivisor(1, divisor)
      gl.vertexAttribDivisor(2, divisor)
    }
  }
  gl.bindVertexArray(null)
  // A buffer bound for transform feedback may not also sit on ARRAY_BUFFER.
  gl.bindBuffer(gl.ARRAY_BUFFER, null)

  gl.useProgram(update)
  gl.uniform1i(u.u_cover, UNIT_COVER)
  gl.uniform1i(u.u_coverPrevious, UNIT_COVER_PREVIOUS)
  gl.useProgram(null)

  const coverUv = new Float32Array(4)
  const previousUv = new Float32Array(4)
  const fallback = new Float32Array(3)
  let fallbackVersion = -1
  let swatchSlot: StageCoverSlot | null = null
  let read = 0
  let count = 0
  let frameIndex = 0
  let width = 1
  let height = 1

  function bind(unit: number, texture: WebGLTexture | null): void {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  /** Grow or shrink the live flock. Particles joining start dead, so they are born next update. */
  function setCount(next: number): void {
    if (next > count) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[read])
      gl.bufferSubData(gl.ARRAY_BUFFER, count * STRIDE, new Float32Array((next - count) * FLOATS))
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
    }
    count = next
  }

  function updateFallback(palette: Palette): void {
    if (palette.version === fallbackVersion) return
    fallbackVersion = palette.version
    for (let channel = 0; channel < 3; channel++) {
      fallback[channel] = palette.linear[PaletteSlot.textMuted * 3 + channel]
    }
  }

  return {
    resize(nextWidth, nextHeight) {
      width = Math.max(1, Math.round(nextWidth))
      height = Math.max(1, Math.round(nextHeight))
      setCount(particleCount(width, height))
    },

    frame(audio, palette, stage, dtSec) {
      const aspect = width / height
      const params = model.update(audio, stage.intensity, aspect, dtSec)
      updateFallback(palette)
      frameIndex = (frameIndex + 1) >>> 0

      // 1. Update: read buffers[read], capture into the other.
      const write = 1 - read
      gl.useProgram(update)
      gl.uniform1f(u.u_dt, dtSec > 0 ? dtSec : 0)
      gl.uniform1f(u.u_time, params.time)
      gl.uniform1ui(u.u_frame, frameIndex)
      gl.uniform1f(u.u_aspect, aspect)
      gl.uniform1f(u.u_speed, params.speed)
      gl.uniform4f(u.u_flock, params.x, params.y, params.radiusX, params.radiusY)
      gl.uniform1f(u.u_angle, params.angle)
      gl.uniform3f(u.u_scatter, params.scatterX, params.scatterY, params.scatter)
      gl.uniform3fv(u.u_fallback, fallback)

      const covers = stage.cover
      const current = covers?.current ?? null
      const previous = covers?.previous ?? null
      if (current && current !== swatchSlot) {
        swatchSlot = current
        gl.uniform3fv(u.u_swatches, current.swatches)
      }
      const hasCover = current?.texture != null
      const hasPrevious = hasCover && previous?.texture != null
      gl.uniform1i(u.u_hasCover, hasCover ? 1 : 0)
      gl.uniform1i(u.u_hasPrevious, hasPrevious ? 1 : 0)
      if (current && hasCover) {
        coverUvTransform(current.aspect, aspect, 1, coverUv)
        gl.uniform4fv(u.u_coverUv, coverUv)
        gl.uniform1f(u.u_coverLod, coverLod(current))
        bind(UNIT_COVER, current.texture)
      }
      if (previous && hasPrevious) {
        coverUvTransform(previous.aspect, aspect, 1, previousUv)
        gl.uniform4fv(u.u_coverPreviousUv, previousUv)
        gl.uniform1f(u.u_coverPreviousLod, coverLod(previous))
        gl.uniform1f(u.u_coverMix, covers?.mix ?? 1)
        bind(UNIT_COVER_PREVIOUS, previous.texture)
      }

      gl.bindVertexArray(updateVaos[read])
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback)
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffers[write])
      gl.enable(gl.RASTERIZER_DISCARD)
      gl.beginTransformFeedback(gl.POINTS)
      gl.drawArrays(gl.POINTS, 0, count)
      gl.endTransformFeedback()
      gl.disable(gl.RASTERIZER_DISCARD)
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
      read = write
      bind(UNIT_COVER, null)
      bind(UNIT_COVER_PREVIOUS, null)
      gl.activeTexture(gl.TEXTURE0)

      // 2. Render the buffer just written.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (params.present > 0) {
        gl.useProgram(render)
        gl.uniform1f(r.u_aspect, aspect)
        gl.uniform1f(r.u_halfWidth, HALF_WIDTH)
        gl.uniform1f(r.u_minHalfWidth, MIN_HALF_WIDTH_PX / height)
        gl.uniform1f(r.u_stretch, STRETCH)
        gl.uniform1f(r.u_alpha, ALPHA * params.present)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.bindVertexArray(renderVaos[read])
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count)
        gl.disable(gl.BLEND)
      }
      gl.bindVertexArray(null)
      gl.useProgram(null)
    },

    dispose() {
      gl.deleteTransformFeedback(feedback)
      for (let i = 0; i < 2; i++) {
        gl.deleteVertexArray(updateVaos[i])
        gl.deleteVertexArray(renderVaos[i])
        gl.deleteBuffer(buffers[i])
      }
      gl.deleteProgram(update)
      gl.deleteProgram(render)
    }
  }
}

/** W23-12: a flock in the cover's colours, scattered by onsets. */
export const MURMURATION: VisualizerEffect = {
  id: 'murmuration',
  label: 'Murmuration',
  surface: 'webgl2',
  needs: { cover: true },
  emergence: 'overlay',
  washUnder: 1,
  create
}
