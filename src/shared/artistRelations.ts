import type { NetFailure } from './net'

/**
 * Who the artist is connected to, according to MusicBrainz — **D14**'s third
 * source, and the one the deck exists for.
 *
 * Deliberately not `related.ts`, which is the same English word about a
 * different thing. That module answers "what else in this library shares a tag
 * with this track", is computed from the local index and is exact. This one is a
 * claim about the *world* — bands, members, side projects — fetched over a
 * network, and its whole value is in the join between the two: "the drummer's
 * other band, which you own three albums by" is a sentence neither source can
 * say alone.
 *
 * Like `net.ts` this module stays free of Node and Electron imports: the
 * renderer imports it, and only main is allowed a socket.
 */

/**
 * The shapes a connection comes in, as the pane groups them.
 *
 * Five and not MusicBrainz's forty, and the five are exactly the ones the card
 * names. A deck pane is a column 380px wide; a heading per relationship type is
 * a taxonomy rather than an answer, and there is no catch-all bucket underneath
 * them — a `sibling` or a `teacher` relation is a fact about two people rather
 * than about their music, and a pane that listed it would be spending the
 * operator's attention on the least useful thing MusicBrainz knows. Everything
 * outside these five is dropped at the parse, which is why `relationKind`
 * answers `null` rather than falling back.
 *
 * Direction is baked in where it changes the noun. `member` and `group` are the
 * same MusicBrainz relationship seen from its two ends, and they have to be
 * separate kinds because "the people in this band" and "the bands this person is
 * in" are different lists that a single heading would have to lie about.
 */
export const ARTIST_RELATION_KINDS = [
  /** People in this group. The band seen from the band's end. */
  'member',
  /** Groups this artist plays in. The same relationship seen from a person's end. */
  'group',
  /** Subgroups and supergroups — the side project, in either direction. */
  'side-project',
  /** A one-off or standing joint act, and the artists in it. */
  'collaboration',
  /** The person behind a performing name, or the name in front of a person. */
  'alias'
] as const

export type ArtistRelationKind = (typeof ARTIST_RELATION_KINDS)[number]

/**
 * How a relation was joined to a row in the local library.
 *
 * The card asks for this to be visible rather than hidden, and the reason is
 * that the two are not equally trustworthy. `mbid` is an identity match and is
 * as certain as anything in this app gets. `name` is a *guess* — two artists
 * called Nirvana fold to the same comparison key, and the deck saying "you own
 * this" about the wrong one is exactly **R5**'s confident-and-wrong failure
 * wearing a different hat. So the basis travels with the match and the pane
 * marks the weaker one.
 */
export type ArtistMatchBasis = 'mbid' | 'name'

/**
 * The library's own row for the artist at the other end of a relation.
 *
 * `name` is the library's spelling and not MusicBrainz's, which is the point of
 * carrying it: the row shows MusicBrainz's name because that is what the
 * relation is about, and a name match that joined "Guns N' Roses" to "Guns N
 * Roses" has to be able to show what it actually landed on. `trackCount` is the
 * number that makes the pane worth opening — "three albums by" is the difference
 * between a discovery surface and an encyclopaedia.
 */
export interface LibraryArtistMatch {
  /** The local `artists` row, and what the pane navigates to. */
  artistId: number
  /** The library's spelling. Frequently not MusicBrainz's. */
  name: string
  /** Tracks in the library credited to this artist. Not filtered by anything. */
  trackCount: number
  basis: ArtistMatchBasis
}

/**
 * One artist-to-artist relation, already intersected with the library.
 *
 * Intersected in main rather than in the renderer because the join needs the
 * `artists` table, and a pane that had to ask for one match per row would issue
 * forty round trips to draw a band.
 */
export interface ArtistRelation {
  kind: ArtistRelationKind
  /**
   * MusicBrainz's own relationship type, verbatim — `member of band`,
   * `subgroup`, `is person`.
   *
   * Not drawn anywhere: the heading above a row has already said what kind of
   * connection it is. It is carried because a mapping bug is much easier to see
   * when the thing that was mapped is still on the row, and because a relation
   * that reaches the renderer under the wrong heading is otherwise
   * indistinguishable from one MusicBrainz filed wrongly.
   */
  type: string
  /** The artist at the other end. Always present: relations without one are dropped. */
  mbid: string
  /** MusicBrainz's name for them, which is what the row leads with. */
  name: string
  /** "US grunge band", "drummer" — MusicBrainz's tiebreaker, when it has one. */
  disambiguation: string | null
  /** Instruments, vocals, "original". MusicBrainz's attributes, verbatim. */
  attributes: string[]
  /** Partial dates, as MusicBrainz writes them: `1987-01-01`, `1987`. */
  begin: string | null
  end: string | null
  /** Whether the relationship is over. What makes a member a former member. */
  ended: boolean
  /** The local row, or `null` when the library has nothing for this artist. */
  match: LibraryArtistMatch | null
}

/**
 * What the relations lookup answers with.
 *
 * Three outcomes, matching `ArtistBiographyResult` deliberately: the two panes
 * sit in the same tab and answer to the same identity, and giving them different
 * state vocabularies would mean two ways to write the same four `v-if` branches.
 * `none` covers an artist with no MBID *and* an artist whose MusicBrainz page
 * records no artist relations at all — both are ordinary, and neither is worth a
 * retry.
 */
export type ArtistRelationsStatus = 'ready' | 'none' | 'unavailable'

export interface ArtistRelationsResult {
  artistId: number
  status: ArtistRelationsStatus
  /** Sorted by kind, then current before ended, then owned first, then name. */
  relations: ArtistRelation[]
  /** More relations existed than `ARTIST_RELATION_LIMIT` allowed. */
  truncated: boolean
  /** Present exactly when `status` is `unavailable`. */
  failure: NetFailure | null
}

export interface GetArtistRelationsRequest {
  artistId: number
}

/**
 * Rows the pane will draw, and main will send, at most.
 *
 * Prolific groups are not small: The Fall's MusicBrainz page carries well over a
 * hundred membership relations, and an orchestra's runs into the hundreds. Two
 * hundred and fifty is past what anybody scrolls and small enough that the whole
 * result is a few tens of kilobytes of structured clone.
 *
 * Applied *after* sorting rather than at parse time, which is what makes it
 * safe: the rows a truncation drops are the unowned, ended, alphabetically-late
 * ones, and never the owned artist the operator opened the pane to find.
 */
export const ARTIST_RELATION_LIMIT = 250

/**
 * Attributes kept per relation.
 *
 * A row is one line at a fixed height and its attributes share it with the name.
 * Six is more than fits and well past the point of usefulness — a multi-
 * instrumentalist credited with eleven instruments is telling the operator
 * "several", which the first six already say.
 */
export const ARTIST_RELATION_ATTRIBUTE_LIMIT = 6
