import { coverUvTransform } from '../coverFit'
import type { StageCoverSlot } from '../coverDecode'
import type { StageInputs } from '../effect'
import { saturateMatrix } from '../wash'
import { detailLodFloor } from './plumageModel'

/**
 * The cover layer the WebGL `grow` cover effects share (W23-11, after
 * W23-10's Plumage). The wash is sampled at a moved UV with the cover's own
 * detail mixed in by `u_detail`. The detail is read no finer than the blur
 * floor (`detailLodFloor`), re-encoded to sRGB, saturated with the wash's own
 * matrix and drawn at a growing opacity, so it reads as the wash coming into
 * focus. With `u_detail` at 0 `image()` returns `texture(u_wash, uv)` exactly.
 *
 * Plumage predates this and still carries its own copy of the same GLSL; it
 * was measured bit-exact at emergence 0 and is left alone.
 *
 * `COVER_LAYER_GLSL` declares its own uniforms and helpers. An effect's shader
 * includes it after `precision` and before `main`, and adds the names in
 * {@link COVER_LAYER_UNIFORMS} to its uniform list.
 */

export const COVER_LAYER_GLSL = `
uniform sampler2D u_wash;
uniform sampler2D u_cover;
uniform sampler2D u_coverPrevious;
uniform float u_detail;
uniform float u_opacity;
uniform float u_lodBias;
uniform vec2 u_lodFloor;
uniform vec4 u_coverUv;
uniform vec4 u_coverPreviousUv;
uniform float u_coverMix;
uniform mat3 u_saturate;

vec3 encode(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Four taps on a rotated grid half a texel apart at that mip: smooths the
// bilinear diamonds a magnified mip otherwise shows.
vec4 coverTaps(sampler2D cover, vec2 uv, float lod) {
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

// The same with one tap per cover: for an effect that already averages many samples.
vec4 imageTap(vec2 uv, vec2 lod) {
  vec4 colour = texture(u_wash, uv);
  if (u_detail > 0.0) {
    vec4 current = textureLod(u_cover, uv * u_coverUv.xy + u_coverUv.zw, lod.x);
    if (u_coverMix < 1.0) {
      vec4 previous = textureLod(u_coverPrevious, uv * u_coverPreviousUv.xy + u_coverPreviousUv.zw, lod.y);
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

// The LOD for both covers at a screen UV: never finer than the floor, and never
// finer than the derivative, so a squeezed sample cannot alias. Call before any branch.
vec2 coverLod(vec2 uv) {
  return vec2(
    max(u_lodFloor.x + u_lodBias, derivativeLod(uv * u_coverUv.xy, u_cover)),
    max(u_lodFloor.y + u_lodBias, derivativeLod(uv * u_coverPreviousUv.xy, u_coverPrevious))
  );
}
`

export const COVER_LAYER_UNIFORMS = [
  'u_wash',
  'u_cover',
  'u_coverPrevious',
  'u_detail',
  'u_opacity',
  'u_lodBias',
  'u_lodFloor',
  'u_coverUv',
  'u_coverPreviousUv',
  'u_coverMix',
  'u_saturate'
] as const

type CoverLayerUniform = (typeof COVER_LAYER_UNIFORMS)[number]

/** Used until the host's look arrives; the stage's defaults (D35.12). */
const FALLBACK_OPACITY = 0.2
const FALLBACK_SATURATE = 2.2
const FALLBACK_SCALE = 1.25

export interface CoverLayerUnits {
  readonly wash: number
  readonly cover: number
  readonly coverPrevious: number
}

export interface CoverLayer {
  /** The wash's opacity from the host's look, for the model's cover-layer ramp. */
  washOpacity(stage: StageInputs): number
  /**
   * Bind the wash and covers and set every cover-layer uniform. `detail` is
   * forced to 0 without a cover texture. Call with the effect's program in use.
   */
  apply(
    stage: StageInputs,
    wash: WebGLTexture,
    aspect: number,
    detail: number,
    opacity: number,
    lodBias: number
  ): void
  /** Leave nothing bound on the layer's units. */
  unbind(): void
}

export function createCoverLayer(
  gl: WebGL2RenderingContext,
  u: Readonly<Record<CoverLayerUniform, WebGLUniformLocation | null>>,
  units: CoverLayerUnits
): CoverLayer {
  const coverUv = new Float32Array(4)
  const previousUv = new Float32Array(4)
  let saturateAmount = FALLBACK_SATURATE
  let saturate = new Float32Array(saturateMatrix(FALLBACK_SATURATE))

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
    washOpacity(stage) {
      return stage.wash?.look?.opacity ?? FALLBACK_OPACITY
    },

    apply(stage, wash, aspect, detail, opacity, lodBias) {
      const look = stage.wash?.look ?? null
      const scale = look?.scale ?? FALLBACK_SCALE
      const amount = look?.saturate ?? FALLBACK_SATURATE
      if (amount !== saturateAmount) {
        saturateAmount = amount
        saturate = new Float32Array(saturateMatrix(amount))
      }

      const cover = stage.cover
      const current = cover?.current.texture ?? null
      const previous = cover?.previous?.texture ?? null
      let floor = 0
      let previousFloor = 0
      if (cover && current) floor = fit(cover.current, aspect, scale, coverUv)
      const crossfading = !!(cover?.previous && previous)
      if (crossfading && cover?.previous) {
        previousFloor = fit(cover.previous, aspect, scale, previousUv)
      }

      gl.uniform1i(u.u_wash, units.wash)
      gl.uniform1i(u.u_cover, units.cover)
      gl.uniform1i(u.u_coverPrevious, units.coverPrevious)
      bind(units.wash, wash)
      bind(units.cover, current)
      bind(units.coverPrevious, crossfading ? previous : current)
      // Without a texture there is no cover layer, only the moved wash.
      gl.uniform1f(u.u_detail, current ? detail : 0)
      gl.uniform1f(u.u_opacity, opacity)
      gl.uniform1f(u.u_lodBias, lodBias)
      gl.uniform2f(u.u_lodFloor, floor, crossfading ? previousFloor : floor)
      gl.uniform4fv(u.u_coverUv, coverUv)
      gl.uniform4fv(u.u_coverPreviousUv, crossfading ? previousUv : coverUv)
      gl.uniform1f(u.u_coverMix, crossfading ? (cover?.mix ?? 1) : 1)
      gl.uniformMatrix3fv(u.u_saturate, true, saturate)
    },

    unbind() {
      bind(units.cover, null)
      bind(units.coverPrevious, null)
      bind(units.wash, null)
    }
  }
}
