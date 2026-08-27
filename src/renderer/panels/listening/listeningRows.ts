import { isSearchable, MAX_SEARCH_LENGTH } from '@shared/library'
import type { StatsDimension, StatsQueryResult, StatsRow, StatsSort } from '@shared/stats'
import { formatListeningTime, formatPlays } from '../displayFormat'

/**
 * What the four ranked lists draw, and where a row goes when it is clicked.
 *
 * A module beside the components for `listeningStats.ts`'s reason: the wording,
 * the ordering and — mostly — the click-through rule are the parts worth holding
 * to a test, and a `.vue` file cannot be imported under a Vitest with no Vue
 * plugin. Renderer neighbours are reached by relative path because `tests/`
 * compiles under `tsconfig.node.json`, which maps `@shared` and not `@renderer`.
 */

/**
 * How a row draws its leading thumbnail.
 *
 * `square` for tracks and albums — the cover as it sits on a shelf. `circle` for
 * artists, the Quick Menu's shape for the same idea: a representative album
 * standing in for the person, cropped round so it does not read as *the* record.
 * `none` for genres, which have no cover to show and whose rows stay text.
 */
export type RankedArt = 'square' | 'circle' | 'none'

export interface RankedListSpec {
  readonly dimension: StatsDimension
  readonly title: string
  readonly icon: string
  /** Singular noun for the "top 50 of 431" line. */
  readonly unit: string
  /** Whether the rows carry a cover, and in what shape. */
  readonly art: RankedArt
}

export const RANKED_LISTS: readonly RankedListSpec[] = [
  { dimension: 'track', title: 'Top tracks', icon: 'i-tabler-music', unit: 'track', art: 'square' },
  { dimension: 'album', title: 'Top albums', icon: 'i-tabler-vinyl', unit: 'album', art: 'square' },
  {
    dimension: 'artist',
    title: 'Top artists',
    icon: 'i-tabler-users',
    unit: 'artist',
    art: 'circle'
  },
  { dimension: 'genre', title: 'Top genres', icon: 'i-tabler-tag', unit: 'genre', art: 'none' }
]

export interface RankedRow {
  /** `StatsRow.key`, which is stable within a dimension and a range. */
  readonly key: string
  /** 1-based, so the list can be read as a chart. */
  readonly rank: number
  readonly label: string
  readonly sublabel: string | null
  /** `1,204 plays`. Always shown, whichever total the list is ordered by. */
  readonly plays: string
  /** `2h 18m`. Likewise. */
  readonly time: string
  /**
   * This row's share of the leader's total, `0`–`1`, by the active sort.
   *
   * A top list is a bar chart wearing a list's clothes, and the bar is what
   * turns "1,204 / 1,190 / 402" from three numbers into a shape. It is length
   * and never hue: colouring each row darker-where-bigger would double-encode
   * the one thing the row already says twice.
   */
  readonly share: number
  /**
   * What to narrow the library to, or `null` for a row that does not click.
   *
   * See `revealTextFor`. `null` is an ordinary outcome and not an error — the
   * row still draws, it simply draws as text.
   */
  readonly reveal: string | null
  /**
   * The row's cover hash, passed straight to `artworkUrl`, or `null` for the
   * placeholder. Carried on every dimension; the spec's `art` decides whether a
   * given list draws it.
   */
  readonly artworkHash: string | null
}

/**
 * Where a clicked row lands, and why it lands there by *text*.
 *
 * The obvious click-through is the one the sidebar already has: `revealArtist`
 * takes an `artistId` and selects that row in the facet pane. This cannot use
 * it, and the reason is worth stating rather than working around. A facet
 * artist is an **album-artist identity**, resolved at scan time and falling back
 * to the track artist for loose tracks; a ranked artist is the `artist_name`
 * **snapshot** on a listen, grouped exactly as it was tagged the day it played.
 * Those are two different notions of "artist" that agree most of the time, and
 * matching one to the other by name would be a resolution rule living in a
 * reading surface — quietly right until a compilation, at which point the
 * dashboard opens the wrong artist and gives no sign why.
 *
 * So the click fills the search box instead. It is approximate — searching
 * `Rubber Soul The Beatles` is an infix match over title, artist and album, and
 * it can pull in a track that merely mentions them — and that is the property
 * being chosen: **the operator can see exactly why they got what they got**, in
 * a control they can edit. An imprecise result you can read beats a precise one
 * you cannot.
 *
 * `null` in three cases, each for its own reason:
 * - **Genre**, because the library has no genre predicate to narrow to.
 *   `LibraryBrowseFilters` carries a root, artists, albums and text, and a
 *   genre name searched over title/artist/album matches noise. A genre
 *   dimension in the browse filter is a real feature and a different card.
 * - **Too long to send.** Beyond `MAX_SEARCH_LENGTH` the sublabel is dropped
 *   first; a title that alone exceeds the ceiling does not click.
 * - **Nothing indexable in it.** `isSearchable` is the FTS builder's own rule:
 *   a phrase of only short words compiles to an empty `MATCH`, and a link that
 *   navigates to an empty library is worse than text.
 */
export function revealTextFor(dimension: StatsDimension, row: StatsRow): string | null {
  if (dimension === 'genre') return null

  const joined = row.sublabel === null ? row.label : `${row.label} ${row.sublabel}`
  const text = joined.length <= MAX_SEARCH_LENGTH ? joined : row.label
  if (text.length > MAX_SEARCH_LENGTH) return null

  return isSearchable(text) ? text : null
}

function totalFor(row: StatsRow, sort: StatsSort): number {
  return sort === 'listens' ? row.listens : row.msListened
}

/**
 * The rows for one list, in the order main ranked them.
 *
 * The share is taken against the first row rather than against a scan for the
 * maximum, because the result is already ordered by the sort the share is
 * measured in — and taking it against anything else would draw a bar longer
 * than the leader's.
 */
export function rankedRows(
  result: StatsQueryResult | null,
  sort: StatsSort,
  dimension: StatsDimension
): RankedRow[] {
  if (result === null) return []

  const leader = result.rows.length === 0 ? 0 : totalFor(result.rows[0], sort)

  return result.rows.map((row, index) => ({
    key: row.key,
    rank: index + 1,
    label: row.label,
    sublabel: row.sublabel,
    plays: formatPlays(row.listens),
    time: formatListeningTime(row.msListened),
    share: leader <= 0 ? 0 : Math.min(1, totalFor(row, sort) / leader),
    reveal: revealTextFor(dimension, row),
    artworkHash: row.artworkHash
  }))
}

/**
 * `Top 50 of 431`, or nothing at all.
 *
 * `StatsQueryResult.total` exists for exactly this line — a top list does not
 * page and does not need a total to size a scrollbar, it needs one so that
 * "top 50" is not read as "you have listened to fifty artists". Absent when the
 * list is showing everything there is, because "Top 12 of 12" is a sentence
 * that answers a question nobody asked.
 */
export function rankedCaption(result: StatsQueryResult | null, unit: string): string | null {
  if (result === null || result.rows.length === 0) return null
  if (result.rows.length >= result.total) return null
  return `Top ${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} ${unit}s`
}
