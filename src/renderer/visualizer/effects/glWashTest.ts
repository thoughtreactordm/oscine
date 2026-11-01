import type { EffectInstance, EffectTarget, VisualizerEffect } from '../effect'
import { compileProgram, createFullscreenTriangle, uniformLocations } from '../gl/program'

/**
 * The WebGL tier's test effect — **W23-8, D35.12**. Not a shipped effect: it is
 * registered only in dev builds with `VITE_VISUALIZER_GL_TEST=1`, and exists so
 * the tier's done-when can be checked by eye and by screenshot:
 *
 * - at emergence 0 it is `stage.wash` drawn full-screen as is, so with
 *   `VITE_VISUALIZER_HOLD_EMERGENCE=0` it must be indistinguishable from the CSS
 *   wash;
 * - above 0 the wash ripples, scaled by the emergence, the bass and the flash
 *   guard's intensity, so the grow out of the wash is visible.
 *
 * Its premultiplied output is the wash's own, so the host's handoff opacity
 * applies to it unchanged.
 */

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_wash;
uniform float u_amount;
uniform float u_time;
out vec4 o_colour;
void main() {
  vec2 centred = v_uv - 0.5;
  float ring = sin(length(centred) * 28.0 - u_time * 2.4);
  vec2 uv = v_uv + normalize(centred + 1e-5) * ring * u_amount;
  o_colour = texture(u_wash, uv);
}
`

function create(target: EffectTarget): EffectInstance {
  if (target.surface !== 'webgl2') throw new Error('The WebGL wash test draws on a WebGL2 surface')
  const gl = target.context
  const program = compileProgram(gl, FRAGMENT_SHADER, 'WebGL wash test')
  const uniforms = uniformLocations(gl, program, ['u_wash', 'u_amount', 'u_time'])
  const triangle = createFullscreenTriangle(gl)
  let time = 0

  return {
    resize() {
      // Full-screen in whatever viewport the host sets; nothing sized to keep.
    },
    frame(audio, _palette, stage, dtSec) {
      time += dtSec
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const wash = stage.wash?.source
      if (!wash || !(wash instanceof WebGLTexture)) return
      gl.useProgram(program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, wash)
      gl.uniform1i(uniforms.u_wash, 0)
      gl.uniform1f(
        uniforms.u_amount,
        stage.emergence * (0.004 + 0.02 * audio.bass) * stage.intensity
      )
      gl.uniform1f(uniforms.u_time, time)
      triangle.draw()
    },
    dispose() {
      triangle.dispose()
      gl.deleteProgram(program)
    }
  }
}

export const GL_WASH_TEST: VisualizerEffect = {
  id: 'gl-wash-test',
  label: 'Wash test (WebGL)',
  surface: 'webgl2',
  emergence: 'grow',
  create
}
