/**
 * A `ScrobbleTarget` that implements the whole contract and sends nothing.
 *
 * It exists so that the outbox and its drain worker (W11-2) can be written,
 * built and tested before any Last.fm code exists — which is the only way to
 * find out whether the abstraction holds. A drain worker developed against a
 * real target learns that target's shape by accident; one developed against
 * this cannot, because there is nothing here to learn.
 *
 * Two of its choices are deliberately unhelpful:
 *
 * - `batchLimit` is **3**, not 50. A caller that hardcoded Last.fm's number
 *   fails against this target on the first four-row drain, at build-and-test
 *   time, rather than in W11-8 when ListenBrainz's limit turns out to differ.
 * - An oversized batch is `rejected` outright instead of being split. The
 *   contract says the caller owns the limit; a stub that quietly cleaned up
 *   after a caller which ignored it would be teaching the wrong lesson.
 */

import { netFailed, netOk, type NetResult } from '@shared/net'
import type {
  LovePayload,
  NowPlayingPayload,
  ScrobbleConnection,
  ScrobbleSubmission,
  ScrobbleSubmissionResult,
  ScrobbleTarget,
  ScrobbleTargetCapabilities,
  ScrobbleTargetId
} from '@shared/scrobble'

/** Everything the stub was asked to transmit, in the order it was asked. */
export interface StubScrobbleCalls {
  readonly nowPlaying: NowPlayingPayload[]
  /** One entry per `submit` call, so batching itself is assertable. */
  readonly submitted: ScrobbleSubmission[][]
  readonly loved: LovePayload[]
  readonly unloved: LovePayload[]
  readonly authorized: number
  readonly disconnected: number
}

export interface StubScrobbleTargetOptions {
  /** Which target it stands in for. `lastfm` by default. */
  id?: ScrobbleTargetId
  /** Overrides on top of the stub's own capabilities. */
  capabilities?: Partial<ScrobbleTargetCapabilities>
  /** Whether it starts connected. `true`, because most tests are about drains. */
  connected?: boolean
  username?: string
}

export interface StubScrobbleTarget extends ScrobbleTarget {
  readonly calls: StubScrobbleCalls
}

export function createStubScrobbleTarget(
  options: StubScrobbleTargetOptions = {}
): StubScrobbleTarget {
  const id = options.id ?? 'lastfm'
  const username = options.username ?? 'stub-operator'
  const capabilities: ScrobbleTargetCapabilities = {
    batchLimit: 3,
    supportsLove: true,
    requiresDuration: false,
    ...options.capabilities
  }

  let connected = options.connected ?? true

  const calls: {
    nowPlaying: NowPlayingPayload[]
    submitted: ScrobbleSubmission[][]
    loved: LovePayload[]
    unloved: LovePayload[]
    authorized: number
    disconnected: number
  } = {
    nowPlaying: [],
    submitted: [],
    loved: [],
    unloved: [],
    authorized: 0,
    disconnected: 0
  }

  const connection = (): ScrobbleConnection => ({
    target: id,
    connected,
    username: connected ? username : null
  })

  return {
    id,
    capabilities,
    calls,
    connection,
    authorize: async (): Promise<NetResult<ScrobbleConnection>> => {
      calls.authorized += 1
      connected = true
      return netOk(connection())
    },
    disconnect: async (): Promise<void> => {
      calls.disconnected += 1
      connected = false
    },
    nowPlaying: async (payload: NowPlayingPayload): Promise<void> => {
      calls.nowPlaying.push(payload)
    },
    submit: async (
      batch: readonly ScrobbleSubmission[]
    ): Promise<NetResult<ScrobbleSubmissionResult[]>> => {
      if (batch.length > capabilities.batchLimit) {
        return netFailed({
          kind: 'rejected',
          message: `This target takes ${capabilities.batchLimit} scrobbles at a time, not ${batch.length}.`
        })
      }
      calls.submitted.push([...batch])
      return netOk(batch.map((item) => ({ id: item.id, accepted: true as const })))
    },
    love: async (payload: LovePayload): Promise<NetResult<void>> => {
      calls.loved.push(payload)
      return netOk(undefined)
    },
    unlove: async (payload: LovePayload): Promise<NetResult<void>> => {
      calls.unloved.push(payload)
      return netOk(undefined)
    }
  }
}
