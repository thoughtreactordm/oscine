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
 *
 * ## Scripting failures
 *
 * By default every call succeeds, which is enough to prove a drain worker sends
 * things and not much else. `queueSubmit`, `queueLove` and `queueUnlove` push
 * responders onto a FIFO consumed one per call, falling back to the accepting
 * default once it empties — so a test says "the first batch is rate-limited and
 * the second is fine" as two lines rather than as a bespoke fake.
 *
 * The responders are ordinary closures, which is what makes the account-terminal
 * case expressible: a responder that calls `setConnected(false)` before
 * returning a failure is exactly what a real target does when its session key is
 * refused, and it lets the drain worker be tested against that behaviour without
 * this file knowing what a session key is.
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

/** Decides one `submit` call's answer. May have side effects; tests rely on it. */
export type StubSubmitResponder = (
  batch: readonly ScrobbleSubmission[]
) => NetResult<ScrobbleSubmissionResult[]>

/** Decides one `love` or `unlove` call's answer. */
export type StubLoveResponder = (payload: LovePayload) => NetResult<void>

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
  /** Script the next `submit` answers, one responder per call, in order. */
  queueSubmit(...responders: StubSubmitResponder[]): void
  queueLove(...responders: StubLoveResponder[]): void
  queueUnlove(...responders: StubLoveResponder[]): void
  /**
   * Connect or disconnect without going through `authorize`/`disconnect`.
   *
   * So that a responder can stand a target down mid-call — the shape of a
   * refused credential — without that also counting as an operator gesture in
   * `calls.disconnected`.
   */
  setConnected(connected: boolean): void
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

  const submitResponders: StubSubmitResponder[] = []
  const loveResponders: StubLoveResponder[] = []
  const unloveResponders: StubLoveResponder[] = []

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
    queueSubmit: (...responders: StubSubmitResponder[]): void => {
      submitResponders.push(...responders)
    },
    queueLove: (...responders: StubLoveResponder[]): void => {
      loveResponders.push(...responders)
    },
    queueUnlove: (...responders: StubLoveResponder[]): void => {
      unloveResponders.push(...responders)
    },
    setConnected: (next: boolean): void => {
      connected = next
    },
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
      // Recorded before the responder runs: a scripted failure is a call that
      // was made and answered badly, which is a different thing from the
      // oversized batch above that never left the caller.
      calls.submitted.push([...batch])

      const responder = submitResponders.shift()
      if (responder !== undefined) return responder(batch)

      return netOk(batch.map((item) => ({ id: item.id, accepted: true as const })))
    },
    love: async (payload: LovePayload): Promise<NetResult<void>> => {
      calls.loved.push(payload)
      return loveResponders.shift()?.(payload) ?? netOk(undefined)
    },
    unlove: async (payload: LovePayload): Promise<NetResult<void>> => {
      calls.unloved.push(payload)
      return unloveResponders.shift()?.(payload) ?? netOk(undefined)
    }
  }
}
