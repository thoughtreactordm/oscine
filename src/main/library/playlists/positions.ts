/**
 * Fractional position arithmetic, with no database in sight.
 *
 * Playlist order is a REAL column so that dropping a track between two others
 * writes one row instead of renumbering everything below it. On a 20,000-entry
 * playlist that is the difference between an insert the user cannot perceive
 * and one that rewrites 19,998 rows to move a single song.
 *
 * The price is that halving a gap cannot go on forever. A double has 52 bits of
 * mantissa, so roughly 52 successive inserts at the *same seam* exhaust it and
 * the midpoint stops being strictly between its neighbours. That is not a
 * hypothetical — it is what a user does when they audition an ordering by
 * repeatedly dropping the next track into the same spot — so `rebalance` in
 * ./store.ts is the other half of this scheme rather than a safety net nobody
 * ever reaches.
 *
 * Kept separate from the store because the interesting failure is arithmetic,
 * and arithmetic is worth being able to drive to its limit without a database.
 */

/** Spacing used when there is open room, leaving gaps for later inserts. */
const STEP = 1

/**
 * `count` strictly increasing positions in the open interval (`after`,
 * `before`), or `null` if the interval cannot hold that many distinct doubles.
 *
 * A `null` bound means unbounded on that side — an empty playlist passes both,
 * an append passes only `after`, a prepend only `before`. An unbounded side is
 * always satisfiable, so only the two-sided case can return `null`.
 *
 * That case divides the gap into `count + 1` equal steps rather than halving
 * repeatedly. Both produce valid orderings, but halving makes each successive
 * item's gap half the last, so a batch of 4,000 dropped between two neighbours
 * would exhaust the mantissa inside the batch itself; equal steps spend the
 * interval once.
 */
export function spread(
  after: number | null,
  before: number | null,
  count: number
): number[] | null {
  if (count <= 0) return []

  // Appending to an empty playlist is the same arithmetic as appending to a
  // full one, with a base of zero.
  if (before === null) {
    const base = after ?? 0
    const positions: number[] = []
    for (let index = 1; index <= count; index += 1) positions.push(base + index * STEP)
    return positions
  }

  if (after === null) {
    const positions: number[] = []
    for (let index = count; index >= 1; index -= 1) positions.push(before - index * STEP)
    return positions
  }

  // Guard the degenerate input before dividing by it: two entries that already
  // share a position — only reachable from a hand-edited database — would give
  // a zero-width interval and a run of identical "positions".
  if (!(before > after)) return null

  const step = (before - after) / (count + 1)
  const positions: number[] = []
  for (let index = 1; index <= count; index += 1) positions.push(after + step * index)

  // Verified rather than assumed. Floating-point multiplication near the limit
  // can land two consecutive results on the same double, or nudge one onto a
  // bound, and either would silently corrupt the ordering: the rows would be
  // written, and the list would come back in a different order than the user
  // watched it go in.
  let previous = after
  for (const position of positions) {
    if (!(position > previous)) return null
    previous = position
  }
  return previous < before ? positions : null
}
