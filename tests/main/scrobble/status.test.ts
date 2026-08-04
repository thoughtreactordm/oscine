/**
 * What the settings pane is told, and the two ways that answer could be wrong.
 *
 * It could carry something it must not — a credential — or it could be stale,
 * which is the failure W11-7's whole surface is judged on: an operator watching
 * a queue that is not moving cannot tell a broken drain from a broken readout.
 * The retry test is the one that pins the second, because "answer after the
 * pass, not before it" is the difference between a button that works and a
 * button that appears to.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db'
import { createScrobbleAccounts } from '../../../src/main/scrobble/accounts'
import { createScrobbleDrainWorker } from '../../../src/main/scrobble/drain'
import { ScrobbleOutbox, type ScrobbleQueueEntry } from '../../../src/main/scrobble/outbox'
import { createScrobbleStatusService } from '../../../src/main/scrobble/status'
import {
  createStubScrobbleTarget,
  type StubScrobbleTarget
} from '../../../src/main/scrobble/stubTarget'
import { netFailed } from '../../../src/shared/net'
import type { ScrobblePayload } from '../../../src/shared/scrobble'

let dir: string
let db: Database.Database
let outbox: ScrobbleOutbox

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-scrobble-status-'))
  db = openDatabase(join(dir, 'library.db')).db
  outbox = new ScrobbleOutbox(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

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

function enqueue(overrides: Partial<ScrobbleQueueEntry> = {}): number {
  return outbox.enqueue({
    target: 'lastfm',
    kind: 'scrobble',
    listenId: null,
    trackId: null,
    payload: payload(),
    ...overrides
  })
}

function serviceFor(...targets: StubScrobbleTarget[]) {
  const accounts = createScrobbleAccounts({ targets })
  const drain = createScrobbleDrainWorker({ outbox, targets: () => targets })
  return { accounts, drain, status: createScrobbleStatusService({ accounts, outbox, drain }) }
}

describe('the scrobbling status the renderer receives', () => {
  it('joins the connection to the queue reading', () => {
    const target = createStubScrobbleTarget({ username: 'mdelally' })
    enqueue()
    enqueue()

    const { status } = serviceFor(target)

    expect(status.status().targets).toEqual([
      {
        target: 'lastfm',
        connected: true,
        username: 'mdelally',
        queueDepth: 2,
        lastError: null
      }
    ])
  })

  it('carries nothing beyond a target, a boolean, a username, a count and a sentence', () => {
    // D19 asserted as a shape rather than remembered as a rule. A field added to
    // the payload without a thought about what it says fails here.
    const { status } = serviceFor(createStubScrobbleTarget())

    expect(Object.keys(status.status().targets[0]).sort()).toEqual([
      'connected',
      'lastError',
      'queueDepth',
      'target',
      'username'
    ])
  })

  it('reports zero and no error for a build nobody has signed into', () => {
    const target = createStubScrobbleTarget({ connected: false })
    const { status } = serviceFor(target)

    expect(status.status().targets).toEqual([
      { target: 'lastfm', connected: false, username: null, queueDepth: 0, lastError: null }
    ])
  })

  it('counts rows that are backing off, not just rows that are due', async () => {
    // The honest reading. A depth that only counted what was ready would fall to
    // zero the moment a batch was deferred and climb again a minute later, which
    // is a number the operator would learn to distrust.
    const target = createStubScrobbleTarget()
    enqueue()
    target.queueSubmit(() => netFailed({ kind: 'offline', message: 'No route to Last.fm.' }))

    const { drain, status } = serviceFor(target)
    await drain.wake()

    expect(status.status().targets[0]).toMatchObject({
      queueDepth: 1,
      lastError: 'No route to Last.fm.'
    })
  })

  it('answers a retry with what the pass left behind, not with what it found', async () => {
    const target = createStubScrobbleTarget()
    enqueue()
    enqueue()

    const { status } = serviceFor(target)
    expect(status.status().targets[0]?.queueDepth).toBe(2)

    const after = await status.retry()

    expect(after.targets[0]?.queueDepth).toBe(0)
    expect(target.calls.submitted).toHaveLength(1)
  })

  it('reports each target independently', async () => {
    const lastfm = createStubScrobbleTarget({ id: 'lastfm', username: 'mdelally' })
    const listenbrainz = createStubScrobbleTarget({
      id: 'listenbrainz',
      connected: false
    })
    enqueue({ target: 'listenbrainz' })

    const { status } = serviceFor(lastfm, listenbrainz)

    expect(status.status().targets).toEqual([
      { target: 'lastfm', connected: true, username: 'mdelally', queueDepth: 0, lastError: null },
      { target: 'listenbrainz', connected: false, username: null, queueDepth: 1, lastError: null }
    ])
  })
})

describe('the drain announces its passes', () => {
  it('calls back once per pass, so a pane never has to poll', async () => {
    const target = createStubScrobbleTarget()
    const passes: number[] = []
    const drain = createScrobbleDrainWorker({
      outbox,
      targets: () => [target],
      onPass: (report) => passes.push(report.targets.length)
    })

    enqueue()
    await drain.wake()
    await drain.wake()

    expect(passes).toEqual([1, 1])
  })

  it('does not let a listener that throws stop the queue draining', async () => {
    const target = createStubScrobbleTarget()
    const drain = createScrobbleDrainWorker({
      outbox,
      targets: () => [target],
      onPass: () => {
        throw new Error('the settings pane exploded')
      }
    })

    const id = enqueue()
    await expect(drain.wake()).resolves.toBeDefined()

    expect(outbox.depth('lastfm')).toBe(0)
    expect(id).toBeGreaterThan(0)
  })
})
