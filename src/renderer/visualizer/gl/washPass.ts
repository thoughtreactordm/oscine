import { coverUvTransform } from '../coverFit'
import type { StageCoverInput } from '../coverDecode'
import {
  crossfadeAlphas,
  GAUSSIAN_MAX_TAPS,
  gaussianTapsInto,
  saturateMatrix,
  washGeometry,
  type WashLook
} from '../wash'
import type { WashImage } from '../washPass'
import type { CoverTextures } from './coverTexture'
import { compileProgram, createFullscreenTriangle, uniformLocations } from './program'
import { createPingPong, createRenderTarget, type PingPong, type RenderTarget } from './target'

/**
 * The GPU wash pass — **W23-8, D35.12**, matched to the 2D one (`washPass.ts`)
 * and so to `.stage-wash-img`.
 *
 * Per cover, into a target ⅛ the stage box's size (the same `washGeometry` the
 * 2D pass sizes its small canvas with, so σ = 64 px becomes 8 texels — about
 * 240×135 on a 1080p stage):
 *
 * 1. **Downsample.** The object-cover crop of the cover is drawn into the
 *    small target. Its trilinear sampling *is* the trip down the mips, and the
 *    sample is re-encoded to sRGB, because CSS and `ctx.filter` blur and
 *    saturate sRGB-encoded values, not linear light.
 * 2. **Blur**, separable: 25 bilinear taps across, then 25 down (`gaussianTapsInto`).
 *    Samples outside the target count as transparent, as a CSS filter sees
 *    beyond the `<img>`'s box, so the faded rim matches too.
 * 3. **Saturate**, in the second blur pass: unpremultiply, the Filter Effects
 *    matrix, clamp, premultiply — `blur()` then `saturate()`, the order
 *    `.stage-wash-img` writes them.
 *
 * Then, only when the cover state, the crossfade's mix, the look or the size
 * changes, **compose**: the blurred covers under `scale()` about the centre, at
 * the wash opacity, premultiplied — the previous and the current added at
 * `crossfadeAlphas` (the 2D pass's `'lighter'`) — into one texture that `grow`
 * effects receive as `stage.wash` and draw full-screen as is. It is y-up, the
 * size of the small target, and the compositor-like upscale to the effect's
 * target is the effect's bilinear sample of it.
 *
 * Matched within tolerance, not bit-exact: the kernels and the mip averaging
 * (linear light, where the 2D downscale averages sRGB) differ. W23-15 checks it
 * by screenshot.
 */

const DOWNSAMPLE_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_cover;
uniform vec4 u_fit;
out vec4 o_colour;
vec3 encode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec4 c = texture(u_cover, v_uv * u_fit.xy + u_fit.zw);
  o_colour = vec4(encode(c.rgb) * c.a, c.a);
}
`

const BLUR_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_source;
uniform vec2 u_step;
uniform float u_offsets[${GAUSSIAN_MAX_TAPS}];
uniform float u_weights[${GAUSSIAN_MAX_TAPS}];
uniform int u_taps;
uniform mat3 u_saturate;
uniform bool u_finish;
out vec4 o_colour;
vec4 tap(vec2 uv) {
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(u_source, uv) * (inside.x * inside.y);
}
void main() {
  vec4 sum = tap(v_uv) * u_weights[0];
  for (int i = 1; i < ${GAUSSIAN_MAX_TAPS}; i++) {
    if (i >= u_taps) break;
    vec2 d = u_step * u_offsets[i];
    sum += (tap(v_uv + d) + tap(v_uv - d)) * u_weights[i];
  }
  if (u_finish) {
    vec3 rgb = sum.a > 0.0 ? sum.rgb / sum.a : vec3(0.0);
    rgb = clamp(u_saturate * rgb, 0.0, 1.0);
    sum = vec4(rgb * sum.a, sum.a);
  }
  o_colour = sum;
}
`

const COMPOSE_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_wash;
uniform float u_scale;
uniform float u_alpha;
out vec4 o_colour;
void main() {
  vec2 uv = (v_uv - 0.5) / u_scale + 0.5;
  vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  o_colour = texture(u_wash, uv) * (inside.x * inside.y * u_alpha);
}
`

export interface GlWashPass {
  /** The stage box in CSS pixels, as the 2D pass takes it. */
  resize(cssWidth: number, cssHeight: number): void
  setLook(look: WashLook): void
  /** As `WashPass.compose`; draws only when what it shows changed. */
  compose(
    input: StageCoverInput | null,
    image: (slot: StageCoverInput['current']) => WashImage,
    cut: boolean
  ): void
  /** The composed wash: premultiplied, at the wash opacity, y-up. */
  readonly texture: WebGLTexture
  readonly drawn: boolean
  /** Forget everything drawn, so the next compose redraws (after a GPU reset). */
  invalidate(): void
  dispose(): void
}

export function createGlWashPass(gl: WebGL2RenderingContext, covers: CoverTextures): GlWashPass {
  const triangle = createFullscreenTriangle(gl)
  const downsample = compileProgram(gl, DOWNSAMPLE_SHADER, 'wash downsample')
  const blur = compileProgram(gl, BLUR_SHADER, 'wash blur')
  const composeProgram = compileProgram(gl, COMPOSE_SHADER, 'wash compose')
  const downsampleUniforms = uniformLocations(gl, downsample, ['u_cover', 'u_fit'])
  const blurUniforms = uniformLocations(gl, blur, [
    'u_source',
    'u_step',
    'u_offsets',
    'u_weights',
    'u_taps',
    'u_saturate',
    'u_finish'
  ])
  const composeUniforms = uniformLocations(gl, composeProgram, ['u_wash', 'u_scale', 'u_alpha'])

  const fit = new Float32Array(4)
  const offsets = new Float32Array(GAUSSIAN_MAX_TAPS)
  const weights = new Float32Array(GAUSSIAN_MAX_TAPS)
  let taps = 1
  let saturate = new Float32Array(saturateMatrix(1))

  /** Scratch for the two blur halves; the result is copied into a per-cover target. */
  let scratch: PingPong | null = null
  const composed: RenderTarget = createRenderTarget(gl, 1, 1)
  /** The blurred cover per bitmap, valid for `blurredVersion`. */
  const blurred = new Map<ImageBitmap, RenderTarget>()
  let blurredVersion = -1

  let look: WashLook | null = null
  let cssWidth = 0
  let cssHeight = 0
  let smallWidth = 1
  let smallHeight = 1
  let version = 0

  let lastVersion = -1
  let lastCurrent: WashImage | undefined
  let lastPrevious: WashImage | undefined
  let lastMix = -1
  let drawn = false

  function relayout(): void {
    if (!look || cssWidth <= 0 || cssHeight <= 0) return
    const geometry = washGeometry(cssWidth, cssHeight, look.blurPx)
    smallWidth = geometry.width
    smallHeight = geometry.height
    taps = gaussianTapsInto(geometry.blurPx, offsets, weights)
    saturate = new Float32Array(saturateMatrix(look.saturate))
    composed.resize(smallWidth, smallHeight)
    if (scratch) scratch.resize(smallWidth, smallHeight)
    else scratch = createPingPong(gl, smallWidth, smallHeight)
    version++
  }

  function bindTexture(unit: number, texture: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  function blurPass(source: WebGLTexture, target: RenderTarget, horizontal: boolean): void {
    target.bind()
    gl.useProgram(blur)
    bindTexture(0, source)
    gl.uniform1i(blurUniforms.u_source, 0)
    gl.uniform2f(
      blurUniforms.u_step,
      horizontal ? 1 / smallWidth : 0,
      horizontal ? 0 : 1 / smallHeight
    )
    gl.uniform1fv(blurUniforms.u_offsets, offsets)
    gl.uniform1fv(blurUniforms.u_weights, weights)
    gl.uniform1i(blurUniforms.u_taps, taps)
    gl.uniformMatrix3fv(blurUniforms.u_saturate, true, saturate)
    gl.uniform1i(blurUniforms.u_finish, horizontal ? 0 : 1)
    triangle.draw()
  }

  /** The blurred, saturated cover for a bitmap at the current look and size. */
  function blurredFor(bitmap: ImageBitmap): RenderTarget | null {
    if (!look || !scratch) return null
    if (blurredVersion !== version) {
      for (const target of blurred.values()) target.dispose()
      blurred.clear()
      blurredVersion = version
    }
    const cached = blurred.get(bitmap)
    if (cached) return cached
    const cover = covers.textureFor(bitmap)
    if (!cover) return null

    gl.disable(gl.BLEND)
    scratch.write.bind()
    gl.useProgram(downsample)
    bindTexture(0, cover)
    gl.uniform1i(downsampleUniforms.u_cover, 0)
    coverUvTransform(bitmap.width / bitmap.height, smallWidth / smallHeight, 1, fit)
    gl.uniform4fv(downsampleUniforms.u_fit, fit)
    triangle.draw()
    scratch.swap()

    blurPass(scratch.read.texture, scratch.write, true)
    scratch.swap()
    const target = createRenderTarget(gl, smallWidth, smallHeight)
    blurPass(scratch.read.texture, target, false)
    blurred.set(bitmap, target)
    return target
  }

  function prune(current: WashImage, previous: WashImage): void {
    for (const [bitmap, target] of blurred) {
      if (bitmap !== current && bitmap !== previous) {
        target.dispose()
        blurred.delete(bitmap)
      }
    }
  }

  function drawLayer(image: WashImage, alpha: number): boolean {
    if (!image || alpha <= 0 || !look) return false
    const source = blurredFor(image)
    if (!source) return false
    composed.bind()
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(composeProgram)
    bindTexture(0, source.texture)
    gl.uniform1i(composeUniforms.u_wash, 0)
    gl.uniform1f(composeUniforms.u_scale, look.scale)
    gl.uniform1f(composeUniforms.u_alpha, alpha)
    triangle.draw()
    gl.disable(gl.BLEND)
    return true
  }

  return {
    get texture() {
      return composed.texture
    },
    get drawn() {
      return drawn
    },

    resize(nextWidth, nextHeight) {
      if (nextWidth === cssWidth && nextHeight === cssHeight) return
      cssWidth = nextWidth
      cssHeight = nextHeight
      relayout()
    },

    setLook(next) {
      if (
        look &&
        look.blurPx === next.blurPx &&
        look.saturate === next.saturate &&
        look.opacity === next.opacity &&
        look.scale === next.scale
      ) {
        return
      }
      look = next
      // Re-blurs even when only opacity or scale moved: a theme change, one
      // cover's worth of work, not worth a second version to track.
      relayout()
    },

    compose(input, image, cut) {
      const current = input ? image(input.current) : null
      let previous = input?.previous ? image(input.previous) : null
      let mix = input ? input.mix : 1
      if (cut && previous === null) mix = 1
      if (mix >= 1) previous = null

      if (
        version === lastVersion &&
        current === lastCurrent &&
        previous === lastPrevious &&
        mix === lastMix
      ) {
        return
      }
      lastVersion = version
      lastCurrent = current
      lastPrevious = previous
      lastMix = mix

      prune(current, previous)
      if (!look || !scratch) {
        drawn = false
        return
      }
      // Blur first: it binds other targets, and the compose below must not be
      // interrupted between its clear and its draws.
      if (previous) blurredFor(previous)
      if (current) blurredFor(current)

      composed.bind()
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const alphas = crossfadeAlphas(mix, look.opacity)
      const drewPrevious = previous ? drawLayer(previous, alphas.previous) : false
      const drewCurrent = drawLayer(current, alphas.current)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      drawn = drewPrevious || drewCurrent || current === null
    },

    invalidate() {
      version++
      lastVersion = -1
      drawn = false
    },

    dispose() {
      for (const target of blurred.values()) target.dispose()
      blurred.clear()
      scratch?.dispose()
      scratch = null
      composed.dispose()
      triangle.dispose()
      gl.deleteProgram(downsample)
      gl.deleteProgram(blur)
      gl.deleteProgram(composeProgram)
      look = null
      drawn = false
    }
  }
}
