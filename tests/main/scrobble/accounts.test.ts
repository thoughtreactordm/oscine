/**
 * The accounts service: what it announces, and what it will not hand out.
 *
 * Built against the stub target, so nothing here knows what a session key looks
 * like — which is the same reason W11-2's drain worker was built against it.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ScrobbleConnection } from '../../../src/shared/scrobble'
import { createScrobbleAccounts } from '../../../src/main/scrobble/accounts'
import { createStubScrobbleTarget } from '../../../src/main/scrobble/stubTarget'

describe('createScrobbleAccounts', () => {
  it('reports only the targets this build constructed', () => {
    const accounts = createScrobbleAccounts({
      targets: [createStubScrobbleTarget({ id: 'lastfm', connected: false })]
    })
    // ListenBrainz is in `SCROBBLE_TARGET_IDS` because the outbox stores ids and
    // W11-8 is planned. A row for it here would be a button that cannot work.
    expect(accounts.connections().map((connection) => connection.target)).toEqual(['lastfm'])
  })

  it('runs the target’s flow and announces the result', async () => {
    const target = createStubScrobbleTarget({ connected: false, username: 'operator' })
    const announced: ScrobbleConnection[][] = []
    const accounts = createScrobbleAccounts({
      targets: [target],
      onChanged: (connections) => announced.push(connections)
    })

    const result = await accounts.connect('lastfm')

    expect(result.ok).toBe(true)
    expect(target.calls.authorized).toBe(1)
    expect(announced).toEqual([[{ target: 'lastfm', connected: true, username: 'operator' }]])
  })

  it('announces a failed sign-in too, because it may have left the target stood down', async () => {
    const target = createStubScrobbleTarget({ connected: true })
    const announced: ScrobbleConnection[][] = []
    const accounts = createScrobbleAccounts({
      targets: [target],
      onChanged: (connections) => announced.push(connections)
    })

    // A refused credential is the case: `authorize` fails *and* the target is
    // now disconnected, and only one of those two facts is in the return value.
    target.authorize = async () => {
      target.setConnected(false)
      return { ok: false, failure: { kind: 'rejected', message: 'no' } }
    }
    const result = await accounts.connect('lastfm')

    expect(result.ok).toBe(false)
    expect(announced).toEqual([[{ target: 'lastfm', connected: false, username: null }]])
  })

  it('disconnects and announces', async () => {
    const target = createStubScrobbleTarget({ connected: true })
    const announced: ScrobbleConnection[][] = []
    const accounts = createScrobbleAccounts({
      targets: [target],
      onChanged: (connections) => announced.push(connections)
    })

    await accounts.disconnect('lastfm')

    expect(target.calls.disconnected).toBe(1)
    expect(accounts.connections()[0].connected).toBe(false)
    expect(announced).toHaveLength(1)
  })

  it('refuses a target this build cannot construct rather than throwing', async () => {
    const accounts = createScrobbleAccounts({ targets: [createStubScrobbleTarget()] })
    const result = await accounts.connect('listenbrainz')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.kind).toBe('rejected')
  })

  it('cancelling an unknown or uncancellable target is a no-op', () => {
    const accounts = createScrobbleAccounts({ targets: [createStubScrobbleTarget()] })
    // The stub has no `cancelAuthorize`; the optional call must not explode.
    expect(() => accounts.cancelConnect('lastfm')).not.toThrow()
    expect(() => accounts.cancelConnect('listenbrainz')).not.toThrow()
  })

  it('forwards a cancellation to a target that supports one', () => {
    const cancelAuthorize = vi.fn()
    const accounts = createScrobbleAccounts({
      targets: [{ ...createStubScrobbleTarget(), cancelAuthorize }]
    })
    accounts.cancelConnect('lastfm')
    expect(cancelAuthorize).toHaveBeenCalledOnce()
  })

  it('disconnecting a target this build does not have is a no-op', async () => {
    const accounts = createScrobbleAccounts({ targets: [createStubScrobbleTarget()] })
    await expect(accounts.disconnect('listenbrainz')).resolves.toBeUndefined()
  })

  it('hands the target itself only to main-process callers', () => {
    const target = createStubScrobbleTarget()
    const accounts = createScrobbleAccounts({ targets: [target] })
    // W11-4's drain worker needs the target; nothing that crosses IPC does, and
    // `connections()` is what the IPC layer is given instead.
    expect(accounts.target('lastfm')).toBe(target)
    expect(accounts.target('listenbrainz')).toBeNull()
  })
})
