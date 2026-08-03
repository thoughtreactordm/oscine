/**
 * How long a failed row waits before the drain worker tries it again.
 *
 * A pure function of the row's attempt count and a random source, separated
 * from the worker so that "does backoff grow, and is it bounded" is a table
 * test rather than an exercise in fake timers.
 */

/**
 * The first retry's ceiling. Deliberately not seconds.
 *
 * Nothing here is urgent — a scrobble arriving thirty seconds late is
 * indistinguishable from one arriving on time — and the failures this backs off
 * from are almost all "the network is gone", which does not come back inside a
 * second. Retrying faster would spend the operator's rate-limit budget on a
 * socket that cannot connect.
 */
export const SCROBBLE_BACKOFF_BASE_MS = 30_000

/**
 * The ceiling, six hours.
 *
 * Bounded because an unbounded exponential turns a laptop shut for a fortnight
 * into a queue whose next attempt is a month out — the network is back and the
 * scrobbles are not sent, which is the failure mode that makes an outbox look
 * broken. Six hours means a machine that wakes up connected drains within one
 * working day even if nothing else wakes the worker, and the enqueue, app-start
 * and network-return wakes almost always beat the timer to it anyway.
 */
export const SCROBBLE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

/**
 * Guards `2 ** attempts` against a row that has been failing for years.
 *
 * Well past the point the ceiling takes over; it exists so the arithmetic
 * stays finite rather than to shape the curve.
 */
const MAX_EXPONENT = 32

export interface BackoffInput {
  /** Attempts already spent on this row. 0 for a row that has never been tried. */
  readonly attempts: number
  /**
   * What the service asked us to wait, when it said so.
   *
   * Honoured even past the ceiling: a target that names a number is telling us
   * something the curve cannot know, and ignoring it is how an account gets
   * throttled harder. It raises the delay and never lowers it.
   */
  readonly retryAfterSeconds?: number
  /** `Math.random` in production; a fixed source in tests. */
  readonly random: () => number
  readonly baseMs?: number
  readonly maxMs?: number
}

/**
 * The delay, in ms, before this row may be attempted again.
 *
 * Equal jitter — half the window fixed, half random — rather than full jitter.
 * Full jitter can hand a row that has failed eight times a two-second delay,
 * which puts it back on the wire before the condition that failed it has moved,
 * and the fixed half is what makes the curve actually a curve. Every result is
 * at least half the nominal delay, so progress is monotone and a caller can
 * reason about the worst case.
 *
 * Never returns zero: a row rescheduled to *now* is a row the next `ready()`
 * claims again immediately, which is a spin, not a retry.
 */
export function backoffDelayMs(input: BackoffInput): number {
  const base = input.baseMs ?? SCROBBLE_BACKOFF_BASE_MS
  const max = input.maxMs ?? SCROBBLE_BACKOFF_MAX_MS

  const exponent = Math.min(Math.max(Math.trunc(input.attempts), 0), MAX_EXPONENT)
  const nominal = Math.min(base * 2 ** exponent, max)

  const half = nominal / 2
  const jittered = Math.round(half + clamp01(input.random()) * half)

  const requested =
    input.retryAfterSeconds !== undefined && Number.isFinite(input.retryAfterSeconds)
      ? Math.max(0, Math.round(input.retryAfterSeconds * 1000))
      : 0

  return Math.max(1, jittered, requested)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}
