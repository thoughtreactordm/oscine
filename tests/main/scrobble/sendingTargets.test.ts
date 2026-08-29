/**
 * The pause switch, and the claim that makes it worth having: off means off for
 * every path that sends.
 *
 * Four consumers take their targets through `createSendingTargets` — the drain,
 * the now-playing announcer, the listen commit's enqueue and the loved push —
 * and the bug this file exists to catch is the one where three of them do. The
 * fifth consumer, the accounts service, deliberately does not, because a target
 * that vanished from the settings pane when switched off would take its own
 * switch with it.
 */

import { describe, expect, it } from 'vitest'
import { createSendingTargets, scrobbleTargetEnabled } from '../../../src/main/scrobble/enabled'
import { createStubScrobbleTarget } from '../../../src/main/scrobble/stubTarget'
import { LASTFM_ENABLED } from '../../../src/shared/settings'
import type { ScrobbleTargetId } from '../../../src/shared/scrobble'

describe('which targets may send', () => {
  it('includes a target whose switch is on', () => {
    const target = createStubScrobbleTarget()
    const sending = createSendingTargets({
      targets: () => [target],
      getBoolean: () => true
    })

    expect(sending()).toEqual([target])
  })

  it('excludes a target whose switch is off, connected or not', () => {
    const target = createStubScrobbleTarget({ connected: true })
    const sending = createSendingTargets({
      targets: () => [target],
      getBoolean: () => false
    })

    // Connected and paused is the whole point: pausing must not cost the
    // operator their credential, and disconnecting is a separate gesture.
    expect(target.connection().connected).toBe(true)
    expect(sending()).toEqual([])
  })

  it('reads the setting on every call rather than capturing it', () => {
    // W8 applies a durable write immediately. A filter that had captured the
    // value would be a toggle that needed a restart, which is exactly the class
    // of bug an operator reports as "scrobbling is stuck on".
    let enabled = true
    const target = createStubScrobbleTarget()
    const sending = createSendingTargets({
      targets: () => [target],
      getBoolean: () => enabled
    })

    expect(sending()).toHaveLength(1)
    enabled = false
    expect(sending()).toHaveLength(0)
    enabled = true
    expect(sending()).toHaveLength(1)
  })

  it('pauses one target without pausing the other', () => {
    const lastfm = createStubScrobbleTarget({ id: 'lastfm' })
    const listenbrainz = createStubScrobbleTarget({ id: 'listenbrainz' })
    const sending = createSendingTargets({
      targets: () => [lastfm, listenbrainz],
      getBoolean: (key) => key !== LASTFM_ENABLED
    })

    // Both real targets now have a key; this reads Last.fm's as off and
    // ListenBrainz's as on, so only ListenBrainz may send.
    expect(sending()).toEqual([listenbrainz])
  })

  it('treats a target with no registered switch as on', () => {
    // The alternative — absent key means off — turns a registry that has not
    // caught up with a new target into scrobbles that silently never send, and
    // silence is the one failure this stream cannot notice on its own. Both
    // shipped targets now have a switch, so a hypothetical unregistered id stands
    // in for the target the registry has not caught up with.
    expect(
      scrobbleTargetEnabled('unregistered' as ScrobbleTargetId, () => {
        throw new Error('no key should have been read')
      })
    ).toBe(true)
  })

  it('asks for the key the registry declares for the target', () => {
    const asked: string[] = []
    scrobbleTargetEnabled('lastfm', (key) => {
      asked.push(key)
      return true
    })

    expect(asked).toEqual([LASTFM_ENABLED])
  })
})
