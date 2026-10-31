import type { VisualizerCycle } from '@shared/settings'
import { resolveEffect } from './gate'

/**
 * Which effect the controls move to — **W23-6, D35.5**.
 *
 * Both functions here take the *available* effects (D35.6 can remove entries
 * from the registry for a session) and the stored `interface.visualizerEffect`,
 * and answers with the effect to write, or null when nothing should be written.
 * They step from the effect actually showing — the stored id resolved the way
 * the host resolves it — so an unknown stored id steps from the first available
 * effect, the one the operator is looking at. Nothing here writes; resolving an
 * unknown id never rewrites the setting, and a null answer means "leave it".
 *
 * Pure, `@renderer`-free and DOM-free; randomness is injected so the shuffle is
 * testable.
 */

type Effect = { readonly id: string }

/** Next (+1) or previous (−1), wrapping at the ends. Null with nothing to move to. */
export function stepEffect<E extends Effect>(
  available: readonly E[],
  storedId: string,
  direction: 1 | -1
): E | null {
  const current = resolveEffect(available, storedId)
  if (!current) return null
  const index = available.indexOf(current)
  const next = available[(index + direction + available.length) % available.length]
  // One available effect steps onto itself: nothing visible changes, so nothing
  // is written — not even over an unknown stored id the operator may want back.
  return next === undefined || next === current ? null : next
}

/**
 * The effect a track change moves to under `interface.visualizerCycle`:
 * `'track'` is next in registry order, `'shuffle'` a uniformly random available
 * effect other than the current one, `'off'` nothing. With a single available
 * effect there is nowhere to go, so null.
 *
 * `random` returns a number in [0, 1), like `Math.random`.
 */
export function cycleEffect<E extends Effect>(
  available: readonly E[],
  storedId: string,
  mode: VisualizerCycle,
  random: () => number = Math.random
): E | null {
  if (mode === 'off') return null
  if (mode === 'track') return stepEffect(available, storedId, 1)
  const current = resolveEffect(available, storedId)
  if (!current || available.length < 2) return null
  // Pick among the others: draw an index over length − 1 and skip past the
  // current one, so the current effect is never the answer and the rest stay
  // equally likely.
  const currentIndex = available.indexOf(current)
  const draw = Math.min(available.length - 2, Math.floor(random() * (available.length - 1)))
  return available[draw >= currentIndex ? draw + 1 : draw] ?? null
}
