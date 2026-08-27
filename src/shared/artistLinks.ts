import type { NetFailure } from './net'

/**
 * Where the artist is on the web — **D14**'s fourth source of MusicBrainz truth,
 * and the one that leaves the app entirely.
 *
 * The same `/artist/{mbid}` document `relations.ts` reads, asked with a different
 * `inc`: `url-rels` rather than `artist-rels`. Those are two questions with two
 * answers — who the artist plays with, and where to find them off-library — and
 * they are cached as two documents (see `urlRelationsCacheKey`) so a pane opening
 * one does not pay for the other.
 *
 * Every link here is opened with `shell.openExternal` and never inside a
 * `BrowserWindow`: this app has no in-app view of third-party content, by the
 * card's own acceptance criterion and by the same rule the last.fm auth flow
 * states — the renderer is the last place that should decide a remote page is
 * safe to embed. The URL still crosses `app.openExternal`, which fixes the scheme
 * to http/https at the boundary regardless of what reaches it.
 *
 * Like `net.ts` and `artistRelations.ts` this module stays free of Node and
 * Electron imports: the renderer imports it, and only main is allowed a socket.
 */

/**
 * The kinds of outbound link the pane groups by.
 *
 * Four, and exactly the four the card names. MusicBrainz records dozens of URL
 * relationship types for an artist — Discogs, VIAF, IMDb, Wikidata, lyrics
 * databases, setlist trackers — and most are references for cataloguers rather
 * than places a listener wants to go. This is `ARTIST_RELATION_KINDS`' discipline
 * applied to the other half of the document: a closed set, no catch-all bucket,
 * and everything outside it dropped at the parse, because a link list that
 * included every URL MusicBrainz holds would bury the homepage under a row of
 * authority-control identifiers.
 *
 * `bandcamp` is its own category rather than folded into `purchase`, because the
 * card names it on its own and MusicBrainz gives it its own relationship type: it
 * is the one storefront a format-first listener is most likely to want, and the
 * acceptance criterion is stated about it by name.
 */
export const ARTIST_LINK_CATEGORIES = ['homepage', 'bandcamp', 'purchase', 'social'] as const

export type ArtistLinkCategory = (typeof ARTIST_LINK_CATEGORIES)[number]

/**
 * One outbound link, as it leaves main.
 *
 * `url` is the whole payload the renderer acts on — it is handed straight to
 * `app.openExternal`, which is why it is validated to http/https before it ever
 * reaches here rather than trusted on the way out. `category` is MusicBrainz's
 * own relationship type mapped onto the four, and is what decides the heading and
 * icon; the renderer derives a display label from the URL's host rather than
 * carrying a name lookup that would go stale.
 */
export interface ArtistLink {
  category: ArtistLinkCategory
  /** An absolute http/https URL. Validated at the parse; opened as-is. */
  url: string
}

/**
 * What the links lookup answers with.
 *
 * Three outcomes, matching `ArtistRelationsResult` and `ArtistBiographyResult`
 * deliberately: the four Artist-tab lookups share an identity and a state
 * vocabulary so the panes over them write the same handful of `v-if` branches.
 * `none` covers an artist with no MBID *and* an artist whose MusicBrainz page
 * records no outbound URLs at all — both are ordinary and neither is worth a
 * retry.
 */
export type ArtistLinksStatus = 'ready' | 'none' | 'unavailable'

export interface ArtistLinksResult {
  artistId: number
  status: ArtistLinksStatus
  /** Sorted by category in the order `ARTIST_LINK_CATEGORIES` names, then by URL. */
  links: ArtistLink[]
  /** More links existed than `ARTIST_LINK_LIMIT` allowed. */
  truncated: boolean
  /** Present exactly when `status` is `unavailable`. */
  failure: NetFailure | null
}

export interface GetArtistLinksRequest {
  artistId: number
}

/**
 * Links the pane will draw, and main will send, at most.
 *
 * Far below `ARTIST_RELATION_LIMIT`, because this list does not have a prolific
 * case: an orchestra has hundreds of members but no artist has hundreds of
 * homepages. Fifty is past any real artist's web presence and small enough that
 * the whole result is a rounding error of structured clone. Applied after sorting
 * so a truncation drops the alphabetically-late socials rather than the homepage.
 */
export const ARTIST_LINK_LIMIT = 50
