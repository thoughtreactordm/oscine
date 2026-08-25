/**
 * `track.scrobble` and `track.updateNowPlaying`, as parameters and as a reply —
 * **D19**, W11-4.
 *
 * Pure functions, and deliberately so. Everything in this file is a total
 * function from values to values: the batch that goes out, and what the document
 * that comes back means per row. That is the part of a scrobbling client that is
 * actually hard, and it is the part that a test can pin without a socket, a
 * credential or a clock. `target.ts` keeps the parts that cannot be pure — the
 * session key, the network call, the self-disconnect — and this file keeps the
 * parts that can.
 *
 * ## The reply, and its two shapes
 *
 * Last.fm's JSON is XML with the angle brackets removed, and it shows. A single
 * scrobble comes back as `scrobbles.scrobble` being an **object**; two or more
 * come back as an **array**. Numbers arrive as strings. Every echoed text field
 * is `{ corrected, '#text' }` rather than a string. None of that is negotiable
 * and all of it is handled here rather than at the call site.
 *
 * ## Why results are correlated by position
 *
 * Last.fm does not echo the outbox row id — there is nowhere to put one — so the
 * only correlation available is submission order, which it preserves. `submit`
 * owes its caller `ScrobbleSubmission.id` back, so the mapping is made here,
 * against the batch that was sent.
 *
 * Position alone would be dangerous: a reply that omitted one entry would shift
 * every result after it onto the wrong row, and the visible consequence would be
 * an outbox deleting a listen it never sent while retrying one it did. So the
 * echoed `timestamp` is checked against the submission at that index, and a
 * mismatch leaves that row **unanswered** rather than mis-attributed. The drain
 * worker reschedules what it hears nothing about, so an unanswered row costs a
 * retry and a mis-attributed one costs a scrobble.
 */

import type {
  LovePayload,
  NowPlayingPayload,
  ScrobblePayload,
  ScrobbleSubmission,
  ScrobbleSubmissionResult
} from '@shared/scrobble'
import type { NetFailure } from '@shared/net'
import type { LastfmParams } from './signature'

/**
 * Last.fm's per-scrobble `ignoredMessage` codes.
 *
 * Distinct from the top-level numbered errors in `transport.ts`, and worth
 * saying out loud because they overlap numerically and mean nothing alike: a
 * top-level 5 does not exist, while an ignored-message 5 is a daily quota.
 */
export const LASTFM_IGNORED = {
  /** Not ignored. The scrobble was accepted. */
  none: 0,
  artistIgnored: 1,
  trackIgnored: 2,
  timestampTooOld: 3,
  timestampTooNew: 4,
  /** The account has scrobbled its allowance for the day. */
  dailyLimitExceeded: 5
} as const

/**
 * What to tell the operator when a row is dropped, per code.
 *
 * These end up in `scrobble_queue.last_error` and, through W11-7, in front of a
 * person — so they say what happened to *their* listen rather than quoting a
 * number back at them.
 */
function ignoredReason(code: number, text: string): string {
  switch (code) {
    case LASTFM_IGNORED.artistIgnored:
      return 'Last.fm does not index this artist name.'
    case LASTFM_IGNORED.trackIgnored:
      return 'Last.fm does not index this track.'
    case LASTFM_IGNORED.timestampTooOld:
      return 'Last.fm will not accept a scrobble this old.'
    case LASTFM_IGNORED.timestampTooNew:
      return 'Last.fm will not accept a scrobble dated in the future.'
    default:
      return text === '' ? `Last.fm ignored this scrobble (code ${code}).` : text
  }
}

/**
 * A duration Last.fm will read, or nothing.
 *
 * Zero and negative are dropped rather than sent: a `duration=0` is a claim
 * about the track, and the claim is false. `null` and an absent parameter mean
 * the same thing to Last.fm and neither is an error — `requiresDuration` is
 * false on this target for exactly that reason.
 */
function durationParam(seconds: number | null): string | undefined {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return undefined
  return String(Math.round(seconds))
}

/**
 * The album artist, when it is worth sending.
 *
 * Dropped when it merely repeats the track artist. Last.fm accepts the
 * redundancy, but the field exists to disambiguate a compilation, and sending it
 * on every single-artist album makes the signature longer to no effect.
 */
function albumArtistParam(payload: ScrobblePayload | NowPlayingPayload): string | undefined {
  const albumArtist = payload.albumArtistName
  if (albumArtist === null || albumArtist === '' || albumArtist === payload.artistName) {
    return undefined
  }
  return albumArtist
}

/** The parameters of one listen, minus the index that will be pinned on. */
function listenFields(payload: ScrobblePayload | NowPlayingPayload): LastfmParams {
  return {
    artist: payload.artistName,
    track: payload.title,
    album:
      payload.albumTitle === null || payload.albumTitle === '' ? undefined : payload.albumTitle,
    albumArtist: albumArtistParam(payload),
    duration: durationParam(payload.durationSeconds)
  }
}

/**
 * A batch as `artist[0]`, `track[0]`, `timestamp[0]`, …
 *
 * The index is always written, including for a batch of one. Last.fm permits the
 * bare form for a single scrobble; using it would be a second parameter shape
 * for the same method, reachable only when a batch happens to have one element —
 * which is to say a code path that the common case never exercises and an empty
 * queue always does.
 *
 * The caller adds `method`, `api_key` and `sk`. Those are credentials and
 * routing; this is the payload, and keeping them apart is what lets the batch
 * shape be tested without one.
 */
export function scrobbleBatchParams(batch: readonly ScrobbleSubmission[]): LastfmParams {
  const params: Record<string, string | undefined> = {}
  batch.forEach(({ payload }, index) => {
    for (const [name, value] of Object.entries(listenFields(payload))) {
      params[`${name}[${index}]`] = value
    }
    params[`timestamp[${index}]`] = String(payload.timestamp)
  })
  return params
}

/**
 * `track.updateNowPlaying`'s parameters — the same fields, never indexed.
 *
 * No timestamp, because the message *is* the timestamp: Last.fm records it as
 * happening now and expires it on its own schedule.
 */
export function nowPlayingParams(payload: NowPlayingPayload): LastfmParams {
  return listenFields(payload)
}

/**
 * `track.love` and `track.unlove`'s parameters — two fields and no more (W11-6).
 *
 * Not `listenFields`, and the omissions are the point rather than an economy. A
 * love is a statement about a *song*, not about the copy of it that was playing:
 * Last.fm keys it by artist and title, has no album or duration parameter on
 * either method, and would ignore both if they were sent. There is also no
 * timestamp — `scrobble_queue.timestamp` carries one for a love row, but it is
 * there to order the queue (heart, un-heart, heart again must arrive in that
 * sequence) and never to be transmitted. Last.fm records a love as happening
 * when it receives it, and a love that replayed after a week offline is still
 * simply loved.
 *
 * `track.unlove` takes exactly the same two parameters, which is why one builder
 * serves both and the method name is the whole of the difference.
 */
export function loveParams(payload: LovePayload): LastfmParams {
  return { artist: payload.artistName, track: payload.title }
}

/** `{ corrected: '0', '#text': 'Artist' }`, or occasionally just a string. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && '#text' in value) {
    const text = (value as { '#text': unknown })['#text']
    return typeof text === 'string' ? text : ''
  }
  return ''
}

/** Last.fm sends its numbers as strings about half the time. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** One entry of `scrobbles.scrobble`, before anything has been believed. */
interface ScrobbleEntry {
  timestamp?: unknown
  ignoredMessage?: unknown
}

/** The document `track.scrobble` answers with. */
export interface ScrobbleResponseBody {
  scrobbles?: unknown
}

/**
 * What the reply meant: per-row verdicts, or a reason the whole batch failed.
 *
 * A discriminated union rather than a `NetResult<...>` because the whole-batch
 * arm here is not a network failure — it is a well-formed reply that the
 * contract says must be reported as one, and the distinction is worth keeping
 * until `target.ts` converts it.
 */
export type ScrobbleResponseReading =
  | { readonly ok: true; readonly results: ScrobbleSubmissionResult[] }
  | { readonly ok: false; readonly failure: NetFailure }

/**
 * Read `track.scrobble`'s reply against the batch that produced it.
 *
 * ## The daily limit is not a rejection
 *
 * `ignoredMessage` code 5 means the account has scrobbled its allowance for the
 * day, and it arrives per row looking exactly like the other four. It is not
 * treated like them, because `ScrobbleSubmissionResult` says what
 * `accepted: false` means and this is not it: a rejection is terminal, and the
 * row is deleted with a reason. A daily quota passes on its own by tomorrow, so
 * dropping the row would throw away a listen that would have gone through.
 *
 * It therefore fails the **whole call** as `rate-limited`, which is the outcome
 * the drain worker already backs off.
 *
 * That does discard the acceptances the same reply carried, because a failed
 * call means nothing in the batch was accepted and the contract has no shape for
 * reporting both. Those rows are re-sent on the next pass, and Last.fm
 * de-duplicates a scrobble on artist, track and timestamp — so the cost is a
 * repeated request, not a repeated scrobble. The alternative costs listens.
 */
export function readScrobbleResponse(
  body: ScrobbleResponseBody,
  batch: readonly ScrobbleSubmission[]
): ScrobbleResponseReading {
  const scrobbles = body.scrobbles
  if (typeof scrobbles !== 'object' || scrobbles === null) {
    return {
      ok: false,
      failure: { kind: 'malformed', message: 'Last.fm sent an unreadable scrobble reply.' }
    }
  }

  const raw = (scrobbles as { scrobble?: unknown }).scrobble
  // The single-scrobble shape. `undefined` is its own case: a reply with an
  // `@attr` and no entries at all is malformed rather than empty, because every
  // batch this function is called with has at least one submission in it.
  const entries: unknown[] = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  if (entries.length === 0) {
    return {
      ok: false,
      failure: { kind: 'malformed', message: 'Last.fm sent an unreadable scrobble reply.' }
    }
  }

  const results: ScrobbleSubmissionResult[] = []
  for (const [index, value] of entries.entries()) {
    const submission = batch[index]
    // More entries than we sent. Nothing here can be trusted to belong to a row,
    // so nothing is done with it.
    if (submission === undefined) break
    if (typeof value !== 'object' || value === null) continue

    const entry = value as ScrobbleEntry
    // The guard the file header explains: an echoed timestamp that is not this
    // submission's means the reply is not in the order it was sent, and a result
    // applied to the wrong row deletes a listen that never left.
    const echoed = numberOf(entry.timestamp)
    if (echoed !== null && echoed !== submission.payload.timestamp) continue

    const ignored = entry.ignoredMessage
    const code = numberOf(
      typeof ignored === 'object' && ignored !== null
        ? (ignored as { code?: unknown }).code
        : ignored
    )

    if (code === null || code === LASTFM_IGNORED.none) {
      results.push({ id: submission.id, accepted: true })
      continue
    }

    if (code === LASTFM_IGNORED.dailyLimitExceeded) {
      return {
        ok: false,
        failure: {
          kind: 'rate-limited',
          message: 'Last.fm’s daily scrobble limit has been reached. Oscine will try again later.'
        }
      }
    }

    results.push({
      id: submission.id,
      accepted: false,
      reason: ignoredReason(code, textOf(ignored))
    })
  }

  return { ok: true, results }
}
