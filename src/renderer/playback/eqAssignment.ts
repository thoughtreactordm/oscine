/**
 * Resolving a per-entity EQ preset assignment (W19-6), as pure functions.
 *
 * The impure half — which entity is playing, what its album and artist ids are,
 * what the settings cascade holds for each — lives in the playback controller.
 * This is the two decisions that half feeds into, kept free of Vue and of the
 * settings store so they test under the plain Node config and so the two rules
 * the card is most exacting about are stated once, in isolation:
 *
 * 1. **Most-specific-first.** The assignment is the innermost scope that carries
 *    a row of its own — album beats artist beats playlist — and the global floor
 *    (no assignment) underneath. `pickAssignedPresetId` is that walk.
 * 2. **A deleted preset dangles, it does not lie.** An id that no longer names a
 *    live preset resolves to *no spec* and is reported as dangling, never to an
 *    error and never to the wrong curve. `resolveEqAssignment` is that lookup.
 */

import type { EqualizerPreset, EqualizerSpec } from '@shared/audio/equalizer'

/** One cascade level's answer for the preset-id key, as the store reports it. */
export interface AssignmentLayer {
  /** A row exists at this exact scope (not merely inherited from below). */
  readonly overridden: boolean
  /** The id this scope resolves to — its own when overridden, else inherited. */
  readonly value: string | null
}

/**
 * The winning preset id for an ordered, most-specific-first list of levels.
 *
 * The first level with a row of its own wins; absent any override the answer is
 * the global floor, which every level's `value` already equals. Passing the
 * levels already ordered — album, then artist, then playlist — is the caller's
 * job and the whole of the cascade's opinion; this only names the winner.
 */
export function pickAssignedPresetId(layers: readonly AssignmentLayer[]): string | null {
  for (const layer of layers) {
    if (layer.overridden) return layer.value
  }
  return layers.length > 0 ? layers[layers.length - 1].value : null
}

/** What an assignment resolves to once the preset list is consulted. */
export interface EqAssignment {
  /** The assigned id, whether or not it still names a live preset. */
  readonly presetId: string | null
  /** The matched preset's curve, or null for "no assignment" and for dangling. */
  readonly spec: EqualizerSpec | null
  /** The id is set but names no preset in the list — the entity plays flat. */
  readonly dangling: boolean
}

const NO_ASSIGNMENT: EqAssignment = Object.freeze({ presetId: null, spec: null, dangling: false })

/**
 * Map a resolved id to the spec that should play, or to a reported dangle.
 *
 * A null id is simply no assignment. A non-null id that the list answers is the
 * curve to apply; one it does not is dangling — spec null, so the entity plays
 * flat rather than carrying a stale curve, and `dangling` true so the pane can
 * say which assignments have lost their preset.
 */
export function resolveEqAssignment(
  presetId: string | null,
  presets: readonly EqualizerPreset[]
): EqAssignment {
  if (presetId === null) return NO_ASSIGNMENT
  const preset = presets.find((candidate) => candidate.id === presetId) ?? null
  return { presetId, spec: preset ? preset.spec : null, dangling: preset === null }
}
