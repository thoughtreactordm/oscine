/**
 * What follows what.
 *
 * Until now "next" was `index + 1`, open-coded in three places: the
 * controller's transport, the scheduler's transport, and — the one that
 * matters — the scheduler's prefetch, which decides the successor while the
 * current track is still audible and arms a gapless or crossfade boundary
 * against it. Repeat and shuffle are both the statement "next is not
 * `index + 1` any more", so the arithmetic has to become one thing before
 * either can exist. Shuffle changes *which rows a position names* and so lives
 * in the `PlayOrder` (see `shufflePlayOrder.ts`); repeat changes *which
 * position follows this one* and so lives here.
 *
 * Design §5 rules 6 and 7 are the target shape. Rule 7 gives the up-next queue
 * priority over both, and `upNextQueue.ts` resolves it *before* these functions
 * are consulted rather than inside them — which is why they take a bare index
 * and know nothing about track ids. `chooseSuccessor` is the only caller that
 * has to hold both in its head.
 */

export const REPEAT_MODES = ['off', 'all', 'one'] as const

export type RepeatMode = (typeof REPEAT_MODES)[number]

export function isRepeatMode(value: unknown): value is RepeatMode {
  return typeof value === 'string' && (REPEAT_MODES as readonly string[]).includes(value)
}

/** The single button's cycle: none, then the whole order, then this track. */
export function cycleRepeatMode(mode: RepeatMode): RepeatMode {
  if (mode === 'off') return 'all'
  if (mode === 'all') return 'one'
  return 'off'
}

/**
 * Why a successor is being asked for.
 *
 * The distinction exists for repeat-one and only for repeat-one. Design §5
 * rule 7 says it "overrides everything", which is about the boundary the track
 * reaches on its own — pressing Next under repeat-one moves on, as it does in
 * every player anyone has used. A mode that trapped the transport would be a
 * bug report, not a feature.
 */
export type AdvanceReason = 'boundary' | 'explicit'

/**
 * Whether a length has to be resolved before the successor can be named.
 *
 * `PlayOrder.count()` is a round trip, and the boundary path runs it on every
 * track. Only wrapping needs it: without repeat, running off the end is
 * already reported by `at()` returning `null`, which is the existing clean
 * stop. Consulted by callers so the query is skipped rather than awaited and
 * discarded.
 */
export function needsTotal(repeat: RepeatMode, reason: AdvanceReason): boolean {
  if (repeat === 'off') return false
  return !(repeat === 'one' && reason === 'boundary')
}

/**
 * The position after `from`, or `null` when traversal stops there.
 *
 * `total` may be `null`, meaning the length is unknown — either it was not
 * asked for (see `needsTotal`) or the query failed. Unknown length degrades to
 * not wrapping rather than to guessing: one press at the end of the order does
 * nothing instead of restarting a 100k-row library from the top.
 */
export function nextIndex(
  from: number,
  total: number | null,
  repeat: RepeatMode,
  reason: AdvanceReason
): number | null {
  if (!Number.isInteger(from) || from < 0) return null
  if (repeat === 'one' && reason === 'boundary') return from

  const next = from + 1
  if (total === null) return next
  if (next < total) return next
  // `from` can sit past the end when the library changed under a playing
  // order, so this is "at or beyond the last row", not "exactly the last row".
  return repeat === 'off' || total <= 0 ? null : 0
}

/**
 * The position before `from`, or `null` when there is nowhere to go.
 *
 * Restarting the current track at index 0 is the other convention worth
 * having, and it is deliberately still not here — it is a transport decision
 * about `currentTime`, not a traversal one, and the note at `controller.ts`
 * keeps it with the rest of the transport polish.
 */
export function previousIndex(
  from: number,
  total: number | null,
  repeat: RepeatMode
): number | null {
  if (!Number.isInteger(from) || from < 0) return null
  if (from > 0) return from - 1
  if (repeat === 'off' || total === null || total <= 0) return null
  return total - 1
}
