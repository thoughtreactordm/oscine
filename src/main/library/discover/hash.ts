/**
 * The day's identity, and the only randomness Discover is allowed.
 *
 * Same library + same log + same UTC date → same shelves. Ties break on a
 * hash of `(recipeId, entityId, dayKey)`, never on `RANDOM()`. Changing this
 * function reshuffles a day's ties; treat it as part of the recipe contract.
 */

/** UTC calendar date of `nowMs`, `YYYY-MM-DD`. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

/**
 * Stable 32-bit mix. Unsigned, so a sort on it does not depend on the
 * engine's signed-int behaviour.
 */
export function tieBreak(recipeId: string, entityId: number, day: string): number {
  return fnv1a(`${recipeId}:${entityId}:${day}`)
}

/**
 * Pick one key of many by the day — the selection analogue of `tieBreak`. Hashes
 * each candidate with `(recipeId, key, day)` and returns the smallest, ties
 * broken lexically so the result never depends on input order. Rotates at UTC
 * midnight, stable within a day; like `tieBreak` it is part of the recipe
 * contract, so changing the hash reshuffles the day's pick. Null for no keys.
 */
export function dayPick(recipeId: string, keys: readonly string[], day: string): string | null {
  let best: string | null = null
  let bestHash = 0
  for (const key of keys) {
    const hash = fnv1a(`${recipeId}:${key}:${day}`)
    if (best === null || hash < bestHash || (hash === bestHash && key < best)) {
      best = key
      bestHash = hash
    }
  }
  return best
}

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619

function fnv1a(input: string): number {
  let hash = FNV_OFFSET
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}
