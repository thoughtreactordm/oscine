/**
 * Artist identity as both processes talk about it — **R5**'s vocabulary.
 *
 * A tag string is not an identity. The deck needs to say which of the eleven
 * artists called "Nirvana" it is showing, whether anybody decided that or it was
 * guessed, and how the operator overrules it. That is four things, and they are
 * all in `ArtistResolution` because a pane that has to assemble them from three
 * calls has three chances to render a half-resolved artist.
 *
 * Like `net.ts` this module must stay free of Node and Electron imports: the
 * renderer imports it, and only main is allowed a socket (**D14**).
 */

import type { NetFailure } from './net'

/**
 * Who decided the identity on an `artists` row.
 *
 * The distinction the whole card turns on. `'auto'` is ours and may be revised;
 * `'manual'` is the operator's and is never revised by anything automatic,
 * exactly as **D7** treats a tag correction.
 */
export const ARTIST_MBID_SOURCES = ['auto', 'manual'] as const

export type ArtistMbidSource = (typeof ARTIST_MBID_SOURCES)[number]

/**
 * How far resolution got, phrased as things the deck renders rather than as
 * things that went wrong.
 *
 * Four states and not two, because "we have no identity" splits three ways and
 * the operator's next move differs for each. `ambiguous` wants the picker.
 * `no-match` wants a corrected tag, or nothing. `unavailable` wants a retry, or
 * the consent toggle. Collapsing them into one "unresolved" is how an operator
 * ends up editing a tag that was never wrong.
 */
export const ARTIST_RESOLUTION_STATUSES = [
  /** An identity is on the row. `mbid` is set; `source` says who chose it. */
  'resolved',
  /** Candidates came back and none was clearly the one. The picker is the way out. */
  'ambiguous',
  /** MusicBrainz answered and has nothing for this name. Cached negatively. */
  'no-match',
  /** We could not ask. `failure` says why — declined, offline, timed out, 503. */
  'unavailable'
] as const

export type ArtistResolutionStatus = (typeof ARTIST_RESOLUTION_STATUSES)[number]

/**
 * One MusicBrainz artist the search offered, as the picker draws it.
 *
 * Everything past `mbid` and `name` exists for one reason: telling identically
 * named artists apart. `disambiguation` is MusicBrainz's own one-line answer to
 * that question and is the field the picker leads with; `country`, `type` and
 * `lifeSpan` are what the operator falls back on when the comment is missing.
 */
export interface ArtistCandidate {
  /** The MusicBrainz identifier. A UUID, and the only durable part of this. */
  mbid: string
  name: string
  sortName: string | null
  /** "US grunge band", "Dutch symphonic metal band" — the tiebreaker for a person. */
  disambiguation: string | null
  /** ISO 3166 country code, when MusicBrainz has one. */
  country: string | null
  /** `Group`, `Person`, `Orchestra`, … as MusicBrainz reports it. */
  type: string | null
  /** Years active. Dates are MusicBrainz's partial-date strings: `1987-01-01`, `1987`. */
  begin: string | null
  end: string | null
  /** Our score out of 100, not MusicBrainz's. See `musicbrainz/score.ts`. */
  score: number
}

/** The picker never shows more than this, and main never sends more. */
export const ARTIST_CANDIDATE_LIMIT = 12

/**
 * Everything the deck knows about who is playing.
 *
 * `candidates` is present whatever the status, including `resolved`: the "not
 * this artist?" affordance has to open a populated picker without a second round
 * trip, and the search that produced the current match is the same search that
 * populates it. Empty when we could not ask and nothing was cached — which is
 * the offline case, and is why the picker has an empty state of its own.
 */
export interface ArtistResolution {
  /** The local `artists` row. Stable across a rescan; the name is not. */
  artistId: number
  /** The library's tag string, verbatim. What the deck shows when nothing resolved. */
  name: string
  /** What was actually searched — the tag with any featured-artist trailer removed. */
  query: string
  status: ArtistResolutionStatus
  mbid: string | null
  source: ArtistMbidSource | null
  /** Ranked best first, capped at `ARTIST_CANDIDATE_LIMIT`. */
  candidates: ArtistCandidate[]
  /** Set only when `status` is `unavailable`. Safe to display. */
  failure: NetFailure | null
}

/** Resolution is seeded from the transport, so the query is a track and not a name. */
export interface ResolveArtistQuery {
  trackId: number
}

/**
 * The operator's answer, which is authoritative.
 *
 * `mbid: null` is "none of these" and is a decision, not an absence — it is
 * stored, it survives restart, and it stops the automatic matcher from asking
 * again. Clearing a correction entirely is `artist.clearMbid`, which is a
 * different verb because it means the opposite thing.
 */
export interface SetArtistMbidRequest {
  artistId: number
  mbid: string | null
}

export interface ClearArtistMbidRequest {
  artistId: number
}

/** Opening the picker. By artist rather than by track: the deck already knows which. */
export interface SearchArtistCandidatesRequest {
  artistId: number
}

/** A MusicBrainz identifier, lowercase and hyphenated. Validated on both sides. */
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isMbid(value: string): boolean {
  return MBID_PATTERN.test(value)
}
