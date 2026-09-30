import { parseLrc, type LyricsDocument } from '@shared/lyrics'
import { netFailed, netOk, type NetResult } from '@shared/net'
import type { NetClient } from '../../net/client'

/**
 * The LRCLIB client — tier 3 of the lyrics chain (W17-4). A *client* over W7's
 * fetch layer, not a second HTTP stack: the User-Agent, the rate limiter, the
 * D14 consent gate and the retry policy all come from {@link NetClient}, exactly
 * as the MusicBrainz and Cover Art Archive clients reuse it. This module only
 * builds the query and maps the response.
 *
 * ## Why LRCLIB, and only LRCLIB
 *
 * Keyless and registration-free, and its `/api/get` matches on **duration** —
 * the property that stops a radio edit's timings being drawn over the album cut,
 * the failure mode that makes a lyrics feature untrustworthy. No second provider
 * is added as a fallback here (D-scoped in the card): one source with a duration
 * match beats two without one.
 *
 * ## `/api/get` shape (verified live)
 *
 * ```
 * GET https://lrclib.net/api/get?artist_name=&track_name=&album_name=&duration=
 * → 200 { instrumental, plainLyrics, syncedLyrics, duration, ... }
 * → 404 { name: "TrackNotFound", statusCode: 404 }
 * ```
 *
 * `syncedLyrics` is literal LRC and goes straight through W17-1's {@link parseLrc}.
 * `instrumental: true` is a real answer, rendered as its own state, not a miss.
 * The fuzzy `/api/search` is deliberately not used: its hits are not
 * duration-matched, so they belong to W17-5's manual picker, not to auto-apply.
 */
export interface LrclibQuery {
  readonly artist: string
  readonly title: string
  readonly album: string | null
  /** Track length in seconds, or `null` when the library has no duration for it. */
  readonly durationSec: number | null
}

const LRCLIB_GET_ENDPOINT = 'https://lrclib.net/api/get'

/**
 * How far the returned track's length may differ from ours before it is rejected
 * as a different cut. `/api/get` already matches on duration server-side; this is
 * the belt-and-braces guard so a loose match never mistimes the pane.
 */
export const LRCLIB_DURATION_TOLERANCE_SEC = 2

/** The `/api/get` URL with the querystring the match needs. */
export function lrclibGetUrl(query: LrclibQuery): string {
  const params = new URLSearchParams({
    artist_name: query.artist,
    track_name: query.title
  })
  if (query.album !== null && query.album.trim() !== '') {
    params.set('album_name', query.album)
  }
  if (query.durationSec !== null && query.durationSec > 0) {
    params.set('duration', String(Math.round(query.durationSec)))
  }
  return `${LRCLIB_GET_ENDPOINT}?${params.toString()}`
}

/** The fields of an LRCLIB `/api/get` 200 this client reads. */
interface LrclibGetResponse {
  readonly instrumental?: boolean
  readonly plainLyrics?: string | null
  readonly syncedLyrics?: string | null
  readonly duration?: number
}

/**
 * Fetch and map one track's lyrics from LRCLIB.
 *
 * The result is a {@link NetResult} so it slots straight into `cache.through`:
 * a 404 arrives as a `not-found` failure and is cached negatively; an
 * instrumental or a lyrics document arrives as a success value. Every mapping
 * decision is here rather than in the caller so the cache and the resolver stay
 * ignorant of LRCLIB's field shape.
 */
export async function fetchLrclibLyrics(
  client: NetClient,
  query: LrclibQuery
): Promise<NetResult<LyricsDocument>> {
  const result = await client.getJson<LrclibGetResponse>({
    url: lrclibGetUrl(query),
    scope: 'lyrics',
    accept: 'application/json'
  })
  // A failure — 404 (`not-found`), consent `declined`, a cancelled scope, offline
  // — travels through unchanged; the cache and the resolver read `ok`.
  if (!result.ok) return result

  const body = result.value

  // Reject a returned cut whose length is off by more than the tolerance: that is
  // the radio-edit-over-album-cut mismatch the duration match exists to prevent,
  // and a `not-found` here caches negatively the same as a real 404.
  if (
    query.durationSec !== null &&
    query.durationSec > 0 &&
    typeof body.duration === 'number' &&
    Math.abs(body.duration - query.durationSec) > LRCLIB_DURATION_TOLERANCE_SEC
  ) {
    return netFailed({ kind: 'not-found', message: 'No lyrics matched this track’s length.' })
  }

  // Instrumental is a real answer with no lines — W17-3 renders it as its own
  // state — so it is a success value, not a miss.
  if (body.instrumental === true) {
    return netOk({ lines: [], synced: false, offsetMs: 0, source: 'lrclib', instrumental: true })
  }

  // Prefer genuinely synced lyrics; fall back to plain when the synced field is
  // absent or does not parse to timed lines. `parseLrc` never throws, so
  // malformed synced text degrades to plain rather than taking out the lookup.
  const synced = typeof body.syncedLyrics === 'string' ? body.syncedLyrics.trim() : ''
  let untimedFromSynced: LyricsDocument | null = null
  if (synced !== '') {
    const doc = parseLrc(synced, 'lrclib')
    if (doc.synced) return netOk(doc)
    if (doc.lines.length > 0) untimedFromSynced = doc
  }

  const plain = typeof body.plainLyrics === 'string' ? body.plainLyrics.trim() : ''
  if (plain !== '') {
    const doc = parseLrc(plain, 'lrclib')
    if (doc.lines.length > 0) return netOk(doc)
  }

  // The synced field held only untimed text and there was no plain field — still
  // better to show than to drop.
  if (untimedFromSynced !== null) return netOk(untimedFromSynced)

  // A 200 with neither usable lyrics nor an instrumental flag is nothing to show;
  // treat it as a miss so it caches negatively.
  return netFailed({ kind: 'not-found', message: 'The service has no lyrics for this.' })
}
