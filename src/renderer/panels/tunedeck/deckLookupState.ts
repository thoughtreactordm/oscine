import type { NetFailure } from '@shared/net'

/**
 * The state a deck lookup pane is in, as one value a template switches on — the
 * tested half of **W7-14**, D14's third rule ("offline is a tested state, not
 * an error path").
 *
 * A `.vue` template cannot be imported under this Vitest — `environment: node`,
 * no DOM, no `@renderer` alias — so the branch order that decides which of a
 * pane's states is on screen lives here, beside `relationRows` and
 * `artistIdentity`, where a test can reach it. The panes compute `state` from
 * this and render one block per value; every value is therefore a state a test
 * can drive the pane into by construction.
 *
 * ## The two rules the gate is about
 *
 * `declined` is split from `offline`, and that split is the substance. A lookup
 * refused because external lookups are off is not a failed fetch: no socket was
 * opened, and a "Try again" that cannot succeed while the toggle is off is
 * exactly the error path D14's third rule forbids. So `declined` is a calm,
 * retry-less state of its own — the same call `artistIdentity` already makes
 * when it sets `retryable: failure.kind !== 'declined'`.
 *
 * `not-found` folds into `empty`, per `NetFailure`'s own note: the service
 * answered and had nothing, which reads as "no information" rather than as an
 * error, and is R5's common case for an unmatchable artist.
 */
export type DeckLookupState =
  /** Nothing is playing at all. The pane follows the current track. */
  | 'idle'
  /** Playing, but the artist carries no identity to look anything up by. */
  | 'unresolved'
  /** There is content for the current subject to draw. */
  | 'ready'
  /** A lookup is in flight and there is nothing valid to show underneath it. */
  | 'loading'
  /** External lookups are off. Calm, and no retry — asking again cannot help. */
  | 'declined'
  /** A reachable lookup failed. A message, and a retry worth offering. */
  | 'offline'
  /** The service answered, and had nothing for this artist. */
  | 'empty'

export interface DeckLookupInput {
  /** Nothing is playing at all, as opposed to playing something unidentified. */
  readonly idle: boolean
  /** The identity resolved to no MBID — R5's first-class unresolved state. */
  readonly unresolved: boolean
  /** There is content for *this* subject to draw (rows, a biography, …). */
  readonly hasContent: boolean
  /**
   * A lookup slow enough to admit to, or nothing valid yet with work in flight.
   * True over stale content is deliberate: a pane that prefers a skeleton to the
   * previous artist's answer passes `true` here and gets `loading`, not `ready`.
   */
  readonly loading: boolean
  /** The lookup's failure, scoped to the current subject, or `null`. */
  readonly failure: NetFailure | null
  /** An IPC-level failure with no `NetFailure` body — main did not answer. */
  readonly failed: boolean
}

/**
 * Which state a lookup pane shows, in one place the panes and the tests share.
 *
 * The order is the precedence every content pane already used, with the failure
 * branch split in two. `ready` sits above `loading` so settled content is not
 * hidden by a background refresh, and `loading` passed `true` over stale content
 * is what lets a pane choose the skeleton instead — the branch order does not
 * change, the input does.
 */
export function deckLookupState(input: DeckLookupInput): DeckLookupState {
  if (input.idle) return 'idle'
  if (input.unresolved) return 'unresolved'
  if (input.hasContent && !input.loading) return 'ready'
  if (input.loading) return 'loading'
  if (input.failure?.kind === 'declined') return 'declined'
  if (input.failure?.kind === 'not-found') return 'empty'
  if (input.failure !== null || input.failed) return 'offline'
  return 'empty'
}
