/**
 * Turning a `ScrobblePayload` into ListenBrainz's `submit-listens` body — W11-8.
 *
 * The analogue of `lastfm/scrobbles.ts`, and deliberately its own file for the
 * same reason: the wire shape is a fact about one service, and keeping it out of
 * the target keeps the target about the credential's life and the retry rules
 * that are common to every target.
 *
 * ## The three listen types, and which Oscine sends
 *
 * ListenBrainz's `listen_type` is `single`, `import` or `playing_now`. A drain
 * sends `import`: it is the type for a set of listens submitted after the fact,
 * which is exactly what a queue that has been holding rows through an outage is,
 * and it is correct for a batch of one as well — so there is one submit shape
 * rather than a size-dependent branch. `playing_now` is the now-playing
 * announcement, and its one structural difference is the absence of
 * `listened_at`: the body *is* the claim that this is happening now, so a
 * timestamp would be answering a question nobody asked.
 */

import type { NowPlayingPayload, ScrobblePayload, ScrobbleSubmission } from '@shared/scrobble'

/** What Oscine tells ListenBrainz it is, on every listen's `additional_info`. */
const SUBMISSION_CLIENT = 'Oscine'

export interface ListenbrainzTrackMetadata {
  readonly artist_name: string
  readonly track_name: string
  readonly release_name?: string
  readonly additional_info: {
    readonly media_player: string
    readonly submission_client: string
    /** The track length in **seconds**, omitted when the library does not know it. */
    readonly duration?: number
  }
}

export interface ListenbrainzListen {
  /** UTC seconds the listen started. Present on `import`, absent on `playing_now`. */
  readonly listened_at?: number
  readonly track_metadata: ListenbrainzTrackMetadata
}

export interface ListenbrainzSubmitBody {
  readonly listen_type: 'import' | 'playing_now'
  readonly payload: readonly ListenbrainzListen[]
}

/**
 * The metadata common to a scrobble and a now-playing.
 *
 * `release_name` is set only when there is an album title — a listen with no
 * album is a listen with no release, not one with an empty string. The album's
 * *credited artist* (`albumArtistName`) has no home in ListenBrainz's base
 * schema and is dropped here rather than smuggled into `additional_info`: a
 * target sends the fields it can express, and the abstraction carries the field
 * because Last.fm can. `duration` is included only when known, in seconds — the
 * unit the wire field already uses (see `ScrobblePayload.durationSeconds`).
 */
function trackMetadata(payload: NowPlayingPayload): ListenbrainzTrackMetadata {
  return {
    artist_name: payload.artistName,
    track_name: payload.title,
    ...(payload.albumTitle === null ? {} : { release_name: payload.albumTitle }),
    additional_info: {
      media_player: SUBMISSION_CLIENT,
      submission_client: SUBMISSION_CLIENT,
      ...(payload.durationSeconds === null ? {} : { duration: payload.durationSeconds })
    }
  }
}

/** The `playing_now` body — one listen, no timestamp. */
export function nowPlayingBody(payload: NowPlayingPayload): ListenbrainzSubmitBody {
  return {
    listen_type: 'playing_now',
    payload: [{ track_metadata: trackMetadata(payload) }]
  }
}

/**
 * The `import` body for a batch — one payload entry per submission, each stamped
 * with the moment its listen started.
 *
 * The submissions' `id`s do not travel: ListenBrainz answers a submit whole
 * rather than per item, so there is nothing to correlate them against on the way
 * back. The target reconstructs the per-item results from acceptance of the
 * batch, which is the accept-all-or-reject-all shape this service actually has.
 */
export function submitBody(batch: readonly ScrobbleSubmission[]): ListenbrainzSubmitBody {
  return {
    listen_type: 'import',
    payload: batch.map(({ payload }: { payload: ScrobblePayload }) => ({
      listened_at: payload.timestamp,
      track_metadata: trackMetadata(payload)
    }))
  }
}
