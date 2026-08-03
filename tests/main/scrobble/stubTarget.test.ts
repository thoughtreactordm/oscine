import { describe, expect, it } from 'vitest'
import { NET_SCOPES } from '../../../src/shared/net'
import type { ScrobblePayload, ScrobbleSubmission } from '../../../src/shared/scrobble'
import { createStubScrobbleTarget } from '../../../src/main/scrobble/stubTarget'

function payload(overrides: Partial<ScrobblePayload> = {}): ScrobblePayload {
  return {
    artistName: 'Talk Talk',
    title: 'I Believe In You',
    albumTitle: 'Spirit Of Eden',
    albumArtistName: null,
    durationSeconds: 488,
    timestamp: 1_700_000_000,
    ...overrides
  }
}

function batch(...ids: number[]): ScrobbleSubmission[] {
  return ids.map((id) => ({ id, payload: payload({ timestamp: 1_700_000_000 + id }) }))
}

describe('the scrobble net scope', () => {
  it('is cancellable by the same machinery as the Tunedeck', () => {
    // The drain worker enrols in this scope; if it is not in the closed list,
    // an in-flight batch has nothing that can abandon it and W11-2 would have
    // to grow its own cancellation.
    expect(NET_SCOPES).toContain('scrobble')
  })
})

describe('createStubScrobbleTarget', () => {
  it('reports the connection the operator would be shown, and nothing else', () => {
    const target = createStubScrobbleTarget({ connected: false })

    expect(target.connection()).toEqual({ target: 'lastfm', connected: false, username: null })
    expect(Object.keys(target.connection()).sort()).toEqual(['connected', 'target', 'username'])
  })

  it('connects on authorize and forgets on disconnect', async () => {
    const target = createStubScrobbleTarget({ connected: false, username: 'ada' })

    const result = await target.authorize()

    expect(result).toEqual({
      ok: true,
      value: { target: 'lastfm', connected: true, username: 'ada' }
    })
    expect(target.connection().connected).toBe(true)

    await target.disconnect()

    expect(target.connection()).toEqual({ target: 'lastfm', connected: false, username: null })
  })

  it('answers a batch per item, keyed by the id it was handed', async () => {
    const target = createStubScrobbleTarget()
    const submissions = batch(41, 7, 300)

    const result = await target.submit(submissions)

    // Correlation is by id, not by position: a target that answered for only
    // the items it understood would be indistinguishable from a reordering,
    // and the caller would delete the wrong rows.
    expect(result).toEqual({
      ok: true,
      value: [
        { id: 41, accepted: true },
        { id: 7, accepted: true },
        { id: 300, accepted: true }
      ]
    })
    expect(target.calls.submitted).toEqual([submissions])
  })

  it('fails the whole call when the caller ignores the advertised batch limit', async () => {
    const target = createStubScrobbleTarget()

    // The point of the stub's limit of 3: a drain worker that hardcoded
    // Last.fm's 50 fails here, at test time, rather than against ListenBrainz.
    expect(target.capabilities.batchLimit).toBe(3)

    const result = await target.submit(batch(1, 2, 3, 4))

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.failure.kind).toBe('rejected')
    // Nothing was transmitted, so there is nothing for the caller to delete.
    expect(target.calls.submitted).toEqual([])
  })

  it('takes a full batch at the limit', async () => {
    const target = createStubScrobbleTarget({ capabilities: { batchLimit: 2 } })

    const result = await target.submit(batch(1, 2))

    expect(result.ok).toBe(true)
    expect(target.calls.submitted).toHaveLength(1)
  })

  it('swallows a now-playing announcement rather than reporting it', async () => {
    const target = createStubScrobbleTarget()
    const { timestamp: _timestamp, ...nowPlaying } = payload()

    // Fire-and-forget is a contract, not an implementation detail: the return
    // type has no room for a failure, so no caller can be tempted to queue one.
    await expect(target.nowPlaying(nowPlaying)).resolves.toBeUndefined()
    expect(target.calls.nowPlaying).toEqual([nowPlaying])
    expect(target.calls.submitted).toEqual([])
  })

  it('records loves and unloves separately', async () => {
    const target = createStubScrobbleTarget()
    const love = { artistName: 'Talk Talk', title: 'Desire' }

    expect(await target.love(love)).toEqual({ ok: true, value: undefined })
    expect(await target.unlove(love)).toEqual({ ok: true, value: undefined })

    expect(target.calls.loved).toEqual([love])
    expect(target.calls.unloved).toEqual([love])
  })

  it('can stand in for a target that does not do loves', () => {
    const target = createStubScrobbleTarget({
      id: 'listenbrainz',
      capabilities: { batchLimit: 1000, supportsLove: false, requiresDuration: true }
    })

    expect(target.id).toBe('listenbrainz')
    expect(target.capabilities).toEqual({
      batchLimit: 1000,
      supportsLove: false,
      requiresDuration: true
    })
    expect(target.connection().target).toBe('listenbrainz')
  })
})
