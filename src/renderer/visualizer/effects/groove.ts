import { gammaEncode } from '@shared/theme'
import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, createFullscreenTriangle, uniformLocations } from '../gl/program'
import { PaletteSlot, type Palette } from '../palette'
import { COVER_LAYER_GLSL, COVER_LAYER_UNIFORMS, createCoverLayer } from './coverLayer'
import { createGrooveModel, SMEAR_FLOOR } from './grooveModel'

/**
 * **Groove**: a radial slit-scan of the cover (W23-11, D35.9, D35.11, D35.12),
 * smeared around its centre like a record turning under a light.
 *
 * One full-screen pass at the internal resolution, with no targets. Each
 * pixel averages {@link TAPS} samples of the image (the wash with the cover
 * layer, `coverLayer.ts`) along the arc behind it. The weights fall off
 * towards the arc's far end, so the image stays legible and the smear reads
 * as a trail. Each tap reads a mip no finer than the gap between taps, so a
 * long arc blurs smoothly instead of stepping. The arc is longest under a
 * two-lobed light band that turns with the bass; the band also lifts the
 * palette's highlight a little. The result goes over the unmoved wash by the
 * flash guard's intensity (D35.8).
 *
 * At emergence 0 the arc is skipped and the output is `texture(u_wash, v_uv)`:
 * Groove there *is* the wash. Output is premultiplied and sRGB-encoded, like the
 * wash texture.
 */

const TAPS = 24

const SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
${COVER_LAYER_GLSL}
uniform float u_aspect;
uniform float u_smear;
uniform float u_smearFloor;
uniform float u_phase;
uniform float u_sheen;
uniform vec3 u_light;
uniform float u_present;
out vec4 o_colour;

const int TAPS = ${TAPS};

float band(float angle) {
  float c = 0.5 + 0.5 * cos(2.0 * (angle - u_phase));
  return c * c;
}

void main() {
  vec2 lod = coverLod(v_uv);
  vec2 scale = vec2(u_aspect, 1.0);
  vec2 p = (v_uv - 0.5) * scale;
  float r = length(p);
  if (u_smear <= 0.0 && u_detail <= 0.0) {
    o_colour = texture(u_wash, v_uv);
    return;
  }
  // atan(0, 0) is undefined: the centre pixel has no arc.
  bool centre = r < 1e-5;
  float theta = centre ? 0.0 : atan(p.y, p.x);
  float light = band(theta);
  float arc = centre ? 0.0 : u_smear * mix(u_smearFloor, 1.0, light);

  vec4 colour;
  if (arc <= 0.0) {
    colour = image(v_uv, lod);
  } else {
    // Cover texels per unit of stage height, and the gap between taps in them.
    float perHeight = float(textureSize(u_cover, 0).y) * abs(u_coverUv.y);
    float perHeightPrevious = float(textureSize(u_coverPrevious, 0).y) * abs(u_coverPreviousUv.y);
    float gap = r * arc / float(TAPS - 1);
    vec2 tapLod = max(lod, log2(max(vec2(gap * perHeight, gap * perHeightPrevious), vec2(1.0))));
    vec4 sum = vec4(0.0);
    float total = 0.0;
    for (int i = 0; i < TAPS; i++) {
      float t = float(i) / float(TAPS - 1);
      float w = exp(-2.5 * t);
      // Clockwise: what is here now came from the larger angle.
      float a = theta + arc * t;
      vec2 uv = r * vec2(cos(a), sin(a)) / scale + 0.5;
      sum += imageTap(uv, tapLod) * w;
      total += w;
    }
    colour = sum / total;
  }

  float window = smoothstep(0.06, 0.2, r) * (1.0 - smoothstep(0.55, 0.9, r));
  colour.rgb += u_light * (u_sheen * light * window) * colour.a;
  colour = clamp(colour, 0.0, 1.0);
  colour.rgb = min(colour.rgb, vec3(colour.a));
  o_colour = mix(texture(u_wash, v_uv), colour, u_present);
}
`

const UNIFORMS = [
  ...COVER_LAYER_UNIFORMS,
  'u_aspect',
  'u_smear',
  'u_smearFloor',
  'u_phase',
  'u_sheen',
  'u_light',
  'u_present'
] as const

const UNIT_WASH = 0
const UNIT_COVER = 1
const UNIT_COVER_PREVIOUS = 2

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('Groove draws on a WebGL2 surface')
  const gl = target.context
  const program = compileProgram(gl, SHADER, 'Groove')
  const u = uniformLocations(gl, program, UNIFORMS)
  const triangle = createFullscreenTriangle(gl)
  const model = createGrooveModel()
  const layer = createCoverLayer(gl, u, {
    wash: UNIT_WASH,
    cover: UNIT_COVER,
    coverPrevious: UNIT_COVER_PREVIOUS
  })
  const light = new Float32Array(3)
  let lightVersion = -1

  gl.useProgram(program)
  gl.uniform1f(u.u_smearFloor, SMEAR_FLOOR)
  gl.useProgram(null)

  let width = 1
  let height = 1

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
    },

    frame(audio, palette, stage, dtSec) {
      const wash = stage.wash?.source
      if (!wash || !(wash instanceof WebGLTexture)) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        return
      }
      updateLight(palette)
      const params = model.update(
        audio,
        stage.emergence,
        stage.intensity,
        layer.washOpacity(stage),
        dtSec
      )

      gl.useProgram(program)
      layer.apply(stage, wash, width / height, params.detail, params.opacity, params.lodBias)
      gl.uniform1f(u.u_aspect, width / height)
      gl.uniform1f(u.u_smear, params.smear)
      gl.uniform1f(u.u_phase, params.phase)
      gl.uniform1f(u.u_sheen, params.sheen)
      gl.uniform3fv(u.u_light, light)
      gl.uniform1f(u.u_present, params.present)
      triangle.draw()

      layer.unbind()
      gl.activeTexture(gl.TEXTURE0)
    },

    dispose() {
      triangle.dispose()
      gl.deleteProgram(program)
    }
  }
}

/** W23-11: the cover, smeared like a turning record. */
export const GROOVE: VisualizerEffect = {
  id: 'groove',
  label: 'Groove',
  surface: 'webgl2',
  needs: { cover: true },
  emergence: 'grow',
  create
}
