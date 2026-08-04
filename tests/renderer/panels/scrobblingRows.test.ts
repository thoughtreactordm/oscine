/**
 * The sentences the scrobbling block puts in front of an operator.
 *
 * Each of these is advice, and advice offered in the wrong state is worse than
 * none: "sign in again to send them" under a target the operator has merely
 * paused sends them through a browser round trip to fix something that is not
 * broken. The states are cheap to enumerate and expensive to get wrong, which is
 * what makes them worth a test rather than a careful reading of a template.
 */

import { describe, expect, it } from 'vitest'
import {
  disconnectSummary,
  scrobblingRows,
  waitingLabel
} from '../../../src/renderer/panels/settings/scrobblingRows'
import type { ScrobbleTargetStatus } from '../../../src/shared/scrobble'

function status(overrides: Partial<ScrobbleTargetStatus> = {}): ScrobbleTargetStatus {
  return {
    target: 'lastfm',
    connected: true,
    username: 'mdelally',
    queueDepth: 0,
    lastError: null,
    ...overrides
  }
}

function rows(
  entries: readonly ScrobbleTargetStatus[],
  paused: (target: string) => boolean = () => false
) {
  return scrobblingRows(entries, { paused: (target) => paused(target), problem: () => null })
}

describe('the waiting count', () => {
  it('is singular at one', () => {
    expect(waitingLabel(1)).toBe('1 scrobble waiting to send')
  })

  it('is plural otherwise', () => {
    expect(waitingLabel(3)).toBe('3 scrobbles waiting to send')
  })
})

describe('retry', () => {
  it('is offered when there is something to send and somewhere to send it', () => {
    expect(rows([status({ queueDepth: 4 })])[0]?.canRetry).toBe(true)
  })

  it('is not offered when the queue is empty', () => {
    expect(rows([status({ queueDepth: 0 })])[0]?.canRetry).toBe(false)
  })

  it('is not offered while the target is paused', () => {
    // The worker would wake and skip this target. A button that produces no
    // change is how an operator learns to distrust the number beside it.
    expect(rows([status({ queueDepth: 4 })], () => true)[0]?.canRetry).toBe(false)
  })

  it('is not offered while disconnected', () => {
    expect(rows([status({ connected: false, username: null, queueDepth: 4 })])[0]?.canRetry).toBe(
      false
    )
  })
})

describe('the reconnect prompt', () => {
  it('appears when a queue is stranded with no account', () => {
    // Derived from the pair, never from an error code: a target that stood
    // itself down after its session was refused looks exactly like this, and the
    // renderer is told nothing about a code 9.
    const row = rows([status({ connected: false, username: null, queueDepth: 2 })])[0]
    expect(row?.needsReconnect).toBe(true)
  })

  it('stays away when the queue is empty', () => {
    const row = rows([status({ connected: false, username: null, queueDepth: 0 })])[0]
    expect(row?.needsReconnect).toBe(false)
  })

  it('stays away while paused, where it would be the wrong diagnosis', () => {
    const row = rows([status({ connected: false, username: null, queueDepth: 2 })], () => true)[0]
    expect(row?.needsReconnect).toBe(false)
  })

  it('stays away while connected', () => {
    expect(rows([status({ queueDepth: 2 })])[0]?.needsReconnect).toBe(false)
  })
})

describe('the row', () => {
  it('names the target the way an operator would', () => {
    const [lastfm, listenbrainz] = rows([status(), status({ target: 'listenbrainz' })])
    expect(lastfm?.label).toBe('Last.fm')
    expect(listenbrainz?.label).toBe('ListenBrainz')
  })

  it('carries a sign-in failure only for the target it belongs to', () => {
    const built = scrobblingRows([status(), status({ target: 'listenbrainz' })], {
      paused: () => false,
      problem: (target) => (target === 'listenbrainz' ? 'That token was refused.' : null)
    })

    expect(built[0]?.problem).toBeNull()
    expect(built[1]?.problem).toBe('That token was refused.')
  })
})

describe('what disconnect says it did', () => {
  it('promises the queue survives, and names what Fermata cannot do', () => {
    const summary = disconnectSummary('Last.fm', 3)
    expect(summary).toContain('forgotten the saved sign-in')
    expect(summary).toContain('3 scrobbles stay queued')
    expect(summary).toContain('remove it on Last.fm')
  })

  it('is singular at one', () => {
    expect(disconnectSummary('Last.fm', 1)).toContain('1 scrobble stays queued')
  })

  it('says nothing about a queue that is empty', () => {
    const summary = disconnectSummary('Last.fm', 0)
    expect(summary).not.toContain('queued')
    expect(summary).toContain('remove it on Last.fm')
  })
})
