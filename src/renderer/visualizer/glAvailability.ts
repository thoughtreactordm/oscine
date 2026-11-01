/**
 * Which effects can run this session — **W23-8, D35.6 / R16**.
 *
 * WebGL2 is a tier that must prove itself. Four things take it away, and this
 * is the one place that knows all four:
 *
 * - **The capability probe fails** (software rendering, SwiftShader on a
 *   blocklisted GPU, `--disable-gpu`): every `surface: 'webgl2'` effect is
 *   unavailable for the session. The probe runs once, lazily, the first time a
 *   WebGL effect's availability is asked — so a registry with no WebGL entries
 *   never creates a context at all.
 * - **A shader fails to compile**: only that effect is unavailable, and the
 *   caller is told it is the first time so it logs exactly once.
 * - **The context is lost**: the tier is *suspended* until
 *   `webglcontextrestored`, which is what lets the host fall back to the first
 *   2D effect and come back afterwards.
 * - **Two losses in a session**: the tier is unavailable until restart, restored
 *   or not.
 *
 * A 2D effect is always available (D35.6: the floor). `version` moves whenever
 * an answer could change, so a reactive wrapper can track it.
 *
 * Pure and DOM-free: the probe is injected.
 */

/** Losses after which the tier stays off until restart. */
export const MAX_CONTEXT_LOSSES = 2

export type GlTierState =
  /** Not probed yet. */
  | 'unknown'
  | 'available'
  /** Lost, waiting for `webglcontextrestored`. */
  | 'suspended'
  /** Probe failed, context creation failed, or lost too often. Until restart. */
  | 'unavailable'

export interface AvailabilityEffect {
  readonly id: string
  readonly surface: '2d' | 'webgl2'
}

export interface GlAvailability {
  /** Bumped on every change that could alter an answer. */
  readonly version: number
  /** What is known so far; reading it never probes. For diagnostics. */
  readonly state: GlTierState
  /** How many context losses this session. */
  readonly losses: number
  /** Whether WebGL2 effects may run at all right now. Probes on first ask. */
  tierAvailable(): boolean
  isAvailable(effect: AvailabilityEffect): boolean
  /** The effects that can run now, in the order given. */
  filter<E extends AvailabilityEffect>(effects: readonly E[]): E[]
  /**
   * A shader or program in this effect failed. Returns true the first time for
   * this id — the caller's cue to log, once.
   */
  markEffectFailed(id: string): boolean
  /** A context could not be created after the probe said it could. */
  markTierFailed(): void
  /** `webglcontextlost`. Returns true when this loss turned the tier off for the session. */
  contextLost(): boolean
  /** `webglcontextrestored`. A no-op once the tier is off for the session. */
  contextRestored(): void
}

export function createGlAvailability(probe: () => boolean): GlAvailability {
  let probed: boolean | null = null
  let tierFailed = false
  let lost = false
  let losses = 0
  let version = 0
  const failedEffects = new Set<string>()

  function ensureProbed(): boolean {
    if (probed === null) {
      try {
        probed = probe()
      } catch {
        probed = false
      }
    }
    return probed
  }

  function state(): GlTierState {
    if (tierFailed || losses >= MAX_CONTEXT_LOSSES || probed === false) return 'unavailable'
    if (lost) return 'suspended'
    return probed === null ? 'unknown' : 'available'
  }

  function tierAvailable(): boolean {
    if (tierFailed || losses >= MAX_CONTEXT_LOSSES || lost) return false
    return ensureProbed()
  }

  function isAvailable(effect: AvailabilityEffect): boolean {
    if (effect.surface === '2d') return true
    return !failedEffects.has(effect.id) && tierAvailable()
  }

  return {
    get version() {
      return version
    },
    get state() {
      return state()
    },
    get losses() {
      return losses
    },
    tierAvailable,
    isAvailable,
    filter(effects) {
      return effects.filter(isAvailable)
    },
    markEffectFailed(id) {
      if (failedEffects.has(id)) return false
      failedEffects.add(id)
      version++
      return true
    },
    markTierFailed() {
      if (tierFailed) return
      tierFailed = true
      version++
    },
    contextLost() {
      const wasOff = losses >= MAX_CONTEXT_LOSSES
      losses++
      lost = true
      version++
      return !wasOff && losses >= MAX_CONTEXT_LOSSES
    },
    contextRestored() {
      if (!lost) return
      lost = false
      version++
    }
  }
}
