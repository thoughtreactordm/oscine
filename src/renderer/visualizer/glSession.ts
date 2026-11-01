import { shallowRef } from 'vue'
import type { VisualizerEffect } from './effect'
import { probeWebGl2 } from './gl/context'
import { GlContextLostError } from './gl/program'
import { createGlAvailability } from './glAvailability'

/**
 * The WebGL tier's session state, made reactive — **W23-8, D35.6**.
 *
 * `glAvailability.ts` is the pure model; this is the one instance of it for the
 * session, wired to the real probe, plus a Vue ref that moves with its version
 * so every `computed` that resolves an effect (the host, `StageView`, the
 * palette, the visualizer store) re-resolves when the tier changes. It also
 * keeps hold of a lost context's canvas until it is restored, because by then
 * the stage has already replaced that element with a 2D one.
 */

const availability = createGlAvailability(probeWebGl2)
const version = shallowRef(availability.version)

function publish(): void {
  version.value = availability.version
}

let cachedFor: readonly VisualizerEffect[] | null = null
let cachedVersion = -1
let cached: readonly VisualizerEffect[] = []

/**
 * The available subset of `effects`, the same array while nothing changes (so
 * `computed`s comparing it stay quiet). Reading it inside a `computed` tracks
 * the tier.
 */
export function availableOf(effects: readonly VisualizerEffect[]): readonly VisualizerEffect[] {
  void version.value
  if (cachedFor !== effects || cachedVersion !== availability.version) {
    cached = availability.filter(effects)
    cachedFor = effects
    cachedVersion = availability.version
  }
  return cached
}

/** Diagnostics: where the tier stands. Never probes. */
export function glTierState(): string {
  void version.value
  return availability.state
}

/**
 * An effect threw while being created or drawn. A lost context is not the
 * effect's fault and is handled by the loss path; anything else marks the
 * effect unavailable for the session and is logged once.
 */
export function reportEffectFailure(effect: VisualizerEffect, error: unknown): void {
  if (error instanceof GlContextLostError) return
  if (availability.markEffectFailed(effect.id)) {
    console.warn(`[visualizer] ${effect.label} is unavailable this session`, error)
    publish()
  }
}

/** The stage's own context failed to come up after a good probe. */
export function reportTierFailure(): void {
  if (availability.state === 'unavailable') return
  availability.markTierFailed()
  console.warn('[visualizer] WebGL2 context creation failed; WebGL effects are unavailable')
  publish()
}

let lostCanvas: HTMLCanvasElement | null = null

function onRestored(): void {
  const canvas = lostCanvas
  lostCanvas = null
  canvas?.removeEventListener('webglcontextrestored', onRestored)
  availability.contextRestored()
  publish()
}

/**
 * `webglcontextlost` on the stage canvas (the host has already called
 * `preventDefault()`). Suspends the tier, and keeps the canvas alive to hear
 * `webglcontextrestored`. Returns true when this loss turned the tier off for
 * the session.
 */
export function reportContextLost(canvas: HTMLCanvasElement): boolean {
  const final = availability.contextLost()
  if (lostCanvas && lostCanvas !== canvas) {
    lostCanvas.removeEventListener('webglcontextrestored', onRestored)
  }
  lostCanvas = null
  if (final) {
    console.warn(
      '[visualizer] the WebGL context was lost twice; WebGL effects are off until restart'
    )
  } else {
    lostCanvas = canvas
    canvas.addEventListener('webglcontextrestored', onRestored)
  }
  publish()
  return final
}

/**
 * Dev builds: `window.__oscineVisualizer.loseContext()` forces a loss through
 * `WEBGL_lose_context` (the done-when check for context loss), and
 * `restoreContext()` brings it back. The host points this at its live context.
 */
let devLoseContext: WEBGL_lose_context | null = null
let devLostContext: WEBGL_lose_context | null = null

export function setDevContext(gl: WebGL2RenderingContext | null): void {
  if (!import.meta.env.DEV) return
  devLoseContext = gl?.getExtension('WEBGL_lose_context') ?? null
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.assign(window, {
    __oscineVisualizer: {
      loseContext(): void {
        devLostContext = devLoseContext
        devLostContext?.loseContext()
      },
      restoreContext(): void {
        devLostContext?.restoreContext()
        devLostContext = null
      },
      get tier(): string {
        return availability.state
      },
      get losses(): number {
        return availability.losses
      }
    }
  })
}
