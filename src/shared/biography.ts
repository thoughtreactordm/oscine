import type { NetFailure } from './net'

/**
 * The artist biography, as it crosses the boundary — **D14**'s second source.
 *
 * ## Why the text is a string and not a document
 *
 * Wikipedia's API will hand back HTML if you ask it to, and every field here
 * exists to make sure nobody ever does. `extract` is the plain-text lead
 * section, fetched from the `explaintext` endpoint and stripped again in main
 * before it is allowed onto this type. The renderer interpolates it as text.
 * There is no sanitiser in the renderer because there is nothing to sanitise:
 * remote markup does not reach it, which is a stronger property than escaping
 * it once it has.
 *
 * ## Why the attribution is data rather than a rendered line
 *
 * CC BY-SA requires the work to be attributed and the licence named, with links
 * to both. Composing that sentence in the pane rather than in main is not a
 * layering nicety: `title` and `url` are the two things the licence obliges us
 * to point at, and a pre-rendered string would make it impossible to render
 * either as an actual anchor.
 */
export interface ArtistBiography {
  /** The Wikidata item that joined the MusicBrainz artist to the article. */
  entityId: string
  /** The article title as Wikipedia displays it, redirects already followed. */
  title: string
  /** The wiki's language subtag — `en`, `de`. Which article we ended up on. */
  lang: string
  /** The canonical article URL, from Wikidata's sitelink. The link out. */
  url: string
  /** The lead section, plain text. Never HTML, under any circumstances. */
  extract: string
}

/**
 * What the biography lookup answers with.
 *
 * Three outcomes rather than a nullable biography, because the difference
 * between them is the difference between an empty state and an error state.
 * `none` is the card's normal case — an artist with an MBID and no article, or
 * with no Wikidata item at all — and is the same shape whether the gap is at the
 * first hop or the second. `unavailable` is the only one that carries a
 * `failure` and the only one worth offering a retry for.
 */
export type ArtistBiographyStatus = 'ready' | 'none' | 'unavailable'

export interface ArtistBiographyResult {
  artistId: number
  status: ArtistBiographyStatus
  /** Present exactly when `status` is `ready`. */
  biography: ArtistBiography | null
  /** Present exactly when `status` is `unavailable`. */
  failure: NetFailure | null
}

export interface GetArtistBiographyRequest {
  artistId: number
}

/**
 * The licence the extract arrives under, and where to read it.
 *
 * Constants rather than a literal in the pane so that the test asserting the
 * attribution line is present is asserting against the same two strings the
 * component renders. A licence notice that drifts from the licence is worse
 * than none, because it is a claim rather than an omission.
 *
 * 4.0 rather than 3.0: Wikimedia relicensed its text in June 2023, and the
 * version is part of what has to be named.
 */
export const WIKIPEDIA_LICENCE_NAME = 'CC BY-SA 4.0'
export const WIKIPEDIA_LICENCE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/'
