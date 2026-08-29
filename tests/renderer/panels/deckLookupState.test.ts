import type { NetFailure, NetFailureKind } from '@shared/net'
import { describe, expect, it } from 'vitest'
import {
  deckLookupState,
  type DeckLookupInput
} from '../../../src/renderer/panels/tunedeck/deckLookupState'

/**
 * The tested proof of **W7-14**: every deck lookup pane can be driven into each
 * of its states, and the four the gate names — declined, offline, loading,
 * unresolved — are distinct outcomes rather than one merged failure.
 *
 * The panes render one block per `DeckLookupState`, so an assertion here that a
 * given store shape yields `declined` is an assertion that the pane shows its
 * declined block for that shape. That is the whole reason the branch order was
 * lifted out of the templates and into a function a Node Vitest can call.
 */

function failure(kind: NetFailureKind): NetFailure {
  return { kind, message: `${kind} message` }
}

/** A settled, drawable pane: nothing wrong, content present. */
function base(overrides: Partial<DeckLookupInput> = {}): DeckLookupInput {
  return {
    idle: false,
    unresolved: false,
    hasContent: true,
    loading: false,
    failure: null,
    failed: false,
    ...overrides
  }
}

describe('deckLookupState', () => {
  it('is idle when nothing is playing, before anything else', () => {
    // Idle outranks every other input: an unresolved/failed store left over from
    // the last track must not leak a sentence over a deck that follows nothing.
    expect(deckLookupState(base({ idle: true }))).toBe('idle')
    expect(
      deckLookupState(base({ idle: true, unresolved: true, failure: failure('offline') }))
    ).toBe('idle')
  })

  it('is unresolved when the artist has no identity to look up by', () => {
    expect(deckLookupState(base({ hasContent: false, unresolved: true }))).toBe('unresolved')
    // Unresolved outranks a failure: main does not answer for an unidentified
    // artist, so "who is this" is the honest state, not "could not reach".
    expect(
      deckLookupState(base({ hasContent: false, unresolved: true, failure: failure('offline') }))
    ).toBe('unresolved')
  })

  it('is ready when there is content and nothing in flight', () => {
    expect(deckLookupState(base())).toBe('ready')
  })

  it('is loading while a lookup is in flight with nothing valid to show', () => {
    expect(deckLookupState(base({ hasContent: false, loading: true }))).toBe('loading')
  })

  it('prefers loading over stale content when the pane asks it to', () => {
    // A pane that would rather show a skeleton than the previous artist's answer
    // passes loading:true over content; it gets loading, not ready.
    expect(deckLookupState(base({ hasContent: true, loading: true }))).toBe('loading')
  })

  it('is declined when external lookups are off — the gate split', () => {
    expect(deckLookupState(base({ hasContent: false, failure: failure('declined') }))).toBe(
      'declined'
    )
  })

  it('shows settled content even when a refresh was declined', () => {
    // Declined only surfaces when there is nothing else to draw. Cached content
    // from before the toggle went off still shows.
    expect(deckLookupState(base({ hasContent: true, failure: failure('declined') }))).toBe('ready')
  })

  it('is offline for any reachable failure that a retry could fix', () => {
    for (const kind of ['offline', 'timeout', 'rate-limited', 'unavailable', 'rejected'] as const) {
      expect(deckLookupState(base({ hasContent: false, failure: failure(kind) }))).toBe('offline')
    }
  })

  it('is offline when main did not answer at all', () => {
    expect(deckLookupState(base({ hasContent: false, failed: true }))).toBe('offline')
  })

  it('treats not-found as empty, not as an error', () => {
    // The service answered and had nothing. Per NetFailure, that reads as "no
    // information", so it must not land in the retry-offering offline state.
    expect(deckLookupState(base({ hasContent: false, failure: failure('not-found') }))).toBe(
      'empty'
    )
  })

  it('is empty when a completed lookup simply held nothing', () => {
    expect(deckLookupState(base({ hasContent: false }))).toBe('empty')
  })

  it('separates declined from offline for the same empty pane', () => {
    // The one comparison the whole card turns on: the two failure states a pane
    // used to merge are now two different answers.
    const declined = deckLookupState(base({ hasContent: false, failure: failure('declined') }))
    const offline = deckLookupState(base({ hasContent: false, failure: failure('offline') }))
    expect(declined).toBe('declined')
    expect(offline).toBe('offline')
    expect(declined).not.toBe(offline)
  })
})
