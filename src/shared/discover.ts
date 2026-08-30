/**
 * Discover 1.0 — named local recipes over the library and the listens log
 * (**D20**).
 *
 * A shelf is a bounded, explainable page of playable items, omitted when it
 * cannot fill a minimum. The same library, the same log, and the same UTC day
 * produce the same shelves. Nothing is fetched. A shelf is not a playlist until
 * the operator saves it as one.
 *
 * This module is the IPC vocabulary, not the engine. Recipes live in main.
 * `RelatedAlbum` is the wrong type for a card here: it has no `why`, no artwork,
 * and answers a seed-track question the Tunedeck asks. Discover items are their
 * own shape.
 */

/**
 * The 1.0 catalog, in the order the spec names them — placeholders first, then
 * the five extras, then the day-picked `genre-roulette` (W12-6).
 *
 * This is neither the exclusion walk nor the display order. Recipes claim
 * albums, tracks and artists in one sequence (`for-you`, then `artists`, then
 * the rest, with `revisit` and `genre-roulette` last) so a later shelf cannot
 * reprint an earlier one, and render in another. Both orders belong to compose,
 * not to this list.
 */
export const DISCOVER_RECIPE_IDS = [
  'for-you',
  'unplayed',
  'revisit',
  'artists',
  'almost-finished',
  'forgotten-favorites',
  'because-favorited',
  'neglected-genre',
  'guest-appearances',
  'genre-roulette'
] as const

export type DiscoverRecipeId = (typeof DISCOVER_RECIPE_IDS)[number]

/**
 * What a shelf's cards are. Artist is a selector and a title inside a recipe,
 * not a third grain — there are no local artist portraits without D14.
 */
export const DISCOVER_GRAINS = ['album', 'track'] as const

export type DiscoverGrain = (typeof DISCOVER_GRAINS)[number]

/** Hard query and display cap. Ten cards do not need a windowing library. */
export const SHELF_ITEM_CAP = 10

/** Omit the shelf below this, except cold-start `unplayed`. */
export const SHELF_MIN_ITEMS = 3

export interface DiscoverAlbumItem {
  grain: 'album'
  albumId: number
  title: string
  artist: string | null
  year: number | null
  trackCount: number
  artworkHash: string | null
  /** The specific reason this card is here, one line. */
  why: string
}

export interface DiscoverTrackItem {
  grain: 'track'
  trackId: number
  title: string
  artist: string | null
  albumTitle: string | null
  artworkHash: string | null
  why: string
}

export type DiscoverItem = DiscoverAlbumItem | DiscoverTrackItem

export interface DiscoverShelf {
  id: DiscoverRecipeId
  title: string
  hint: string
  grain: DiscoverGrain
  /**
   * Length in `[SHELF_MIN_ITEMS, SHELF_ITEM_CAP]`, except cold-start `unplayed`,
   * which may be thinner because it may be the only shelf.
   */
  items: DiscoverItem[]
}

export interface DiscoverShelvesResult {
  /** UTC `YYYY-MM-DD` of the clock that produced these shelves. */
  dayKey: string
  shelves: DiscoverShelf[]
}

/**
 * Snapshot the last `discover.shelves` result, not a re-query. The operator is
 * saving what they are looking at.
 */
export interface SaveDiscoverShelfRequest {
  recipeId: DiscoverRecipeId
}
