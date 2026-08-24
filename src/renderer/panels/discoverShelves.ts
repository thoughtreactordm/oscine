import { artworkUrl } from '@shared/ipc'
import type { DiscoverItem } from '@shared/discover'
import type { LibraryBrowseFilters, SortDirection, TrackSortColumn } from '@shared/library'
import { defaultSortFor } from './trackWindow'

/**
 * What Discover draws, and when the Placeholder badge comes off — **D20**.
 *
 * A module beside `favoriteSongs.ts` and for its reason: the branch order is
 * the part worth testing, and a `.vue` file cannot be imported under a Vitest
 * with no Vue plugin. The pane fetches `discover.shelves` and renders; this is
 * which of those answers is on screen, and whether the cards are still
 * skeletons. Recipes stay in main.
 */

/**
 * The four things the pane can be.
 *
 * Named states rather than a chain of `v-else-if` in the template, so the
 * order they are tested in is something a test can hold:
 *
 *   - `failed` outranks a load, because the retry re-enters `loading` and an
 *     alert that said "Reading…" during its own retry would hide the button.
 *   - `loading` is only the wait *before* an answer. A refetch leaves
 *     `answered` true, so the last real result stays on screen (dimmed in the
 *     pane) rather than putting the skeletons back — those are the badge's
 *     reason for existing.
 *   - `empty` is a real result with zero shelves: an empty library, or one
 *     whose albums are all too thin to qualify. Fake vinyls would lie about
 *     that. Cold-start `unplayed` is not this state; it is one shelf.
 */
export type DiscoverViewState = 'failed' | 'loading' | 'empty' | 'shelves'

export interface DiscoverView {
  failed: boolean
  /** `true` once a `discover.shelves` answer has arrived, empty or not. */
  answered: boolean
  shelfCount: number
}

export function discoverViewState(view: DiscoverView): DiscoverViewState {
  if (view.failed) return 'failed'
  if (!view.answered) return 'loading'
  return view.shelfCount === 0 ? 'empty' : 'shelves'
}

/**
 * The Placeholder badge is for "these cards are skeletons".
 *
 * A real result takes it off — one shelf, a cold-start `unplayed`, and the
 * empty library all count. Failed has no cards to apologise for.
 */
export function showPlaceholderBadge(state: DiscoverViewState): boolean {
  return state === 'loading'
}

/**
 * Cover art for one card.
 *
 * The pane only calls this when a hash is present. Hash absent is the vinyl,
 * not the missing-artwork placeholder image — Discover's empty is the
 * token-coloured vinyl the pane already drew as a skeleton.
 */
export function coverSrc(artworkHash: string): string {
  return artworkUrl(artworkHash, 'small')
}

export function discoverItemKey(item: DiscoverItem): string {
  return item.grain === 'album' ? `album:${item.albumId}` : `track:${item.trackId}`
}

/**
 * How an album card plays: the Library album activation, not a second order.
 *
 * `defaultSortFor` with one `albumIds` is disc/track (`trackNo`). The filters
 * are the album alone — Discover is an island, and must not inherit the
 * Library tab's root, search, or artist selection.
 */
export function albumPlayParams(albumId: number): {
  sort: TrackSortColumn
  direction: SortDirection
  filters: LibraryBrowseFilters
} {
  const filters = { albumIds: [albumId] }
  return { sort: defaultSortFor(filters), direction: 'asc', filters }
}

/**
 * How an artist plays: `albumPlayParams`' neighbour, one dimension over.
 *
 * `defaultSortFor` with an `artistIds` filter is `album` — the artist's tracks
 * in release/track order, the same order the Library facets adopt when a row is
 * played (product rule 5). The filter is the artist alone, for `albumPlayParams`'
 * reason: a caller must not inherit the Library tab's root or search.
 */
export function artistPlayParams(artistId: number): {
  sort: TrackSortColumn
  direction: SortDirection
  filters: LibraryBrowseFilters
} {
  const filters = { artistIds: [artistId] }
  return { sort: defaultSortFor(filters), direction: 'asc', filters }
}
