import type { ArtistFavoritesResult } from '@shared/favorites'

/**
 * What the Favorite Songs pane draws, and what its shut header says — **D18**.
 *
 * A module beside `relatedRows.ts` and for its reason: the arithmetic and the
 * branch order are the part worth testing, and a `.vue` file cannot be imported
 * under a Vitest with no Vue plugin. The pane is the rendering; this is the
 * decisions it renders.
 *
 * There is no row type here. The related pane needs one because it flattens
 * headings, tracks and albums into a single fixed-height list; this pane lists
 * tracks and only tracks, in one order, under a heading that is the group's own.
 * A row union over a `Track[]` would be a shape for a variation this pane does
 * not have.
 */

/**
 * The badge on the shut group, or `null` for nothing worth counting.
 *
 * `null` rather than `'0'`, exactly as `countRelatedRows` returns it: the badge
 * exists to answer "is it worth opening", and a bare heading answers that in the
 * negative at least as well as a zero does. It is also the honest reading of the
 * states that produce no number — no artist, no favorites, and not yet asked are
 * all "nothing to show you in here", and none of them is improved by a 0.
 *
 * The `+` is carried through from `truncated`, so a capped answer is never
 * reported as an exact one.
 */
export function countArtistFavorites(result: ArtistFavoritesResult | null): string | null {
  if (result === null) return null

  const total = result.tracks.length
  if (total === 0) return null
  return result.truncated ? `${total}+` : String(total)
}

/**
 * The five things the pane can be, and which one it is.
 *
 * Named states rather than a chain of `v-else-if` in the template, so the order
 * they are tested in is something a test can hold. That order is load-bearing at
 * three points:
 *
 *   - `standby` outranks everything, because a deck with no track is not
 *     describing an artist and has nothing to be empty *of*.
 *   - `failed` outranks `loading`, because the retry re-enters `loading` and a
 *     pane that said "Looking…" during its own retry would hide the button the
 *     operator just needed twice.
 *   - `loading` outranks both `nameless` and `empty`, because the answer that
 *     decides between those two has not arrived yet. Without this, every track
 *     change flashes the invitation before the rows land.
 *
 * `empty` is a *state* and not an error, which is the distinction the card turns
 * on: most artists in a large library have no favorites, and the pane says so as
 * an invitation. It is a peer of `rows` here rather than a branch inside a
 * failure case for exactly that reason.
 */
export type FavoriteSongsState = 'standby' | 'failed' | 'loading' | 'nameless' | 'empty' | 'rows'

export interface FavoriteSongsView {
  /** The seed the deck is describing, or `null` when nothing is playing. */
  seedId: number | null
  loading: boolean
  failed: boolean
  /** `true` once an answer has arrived for the seed, whatever it contained. */
  answered: boolean
  /** The artist the answer was about. `null` when the track named none. */
  artistId: number | null
  count: number
}

export function favoriteSongsState(view: FavoriteSongsView): FavoriteSongsState {
  if (view.seedId === null) return 'standby'
  if (view.failed) return 'failed'
  if (view.loading || !view.answered) return 'loading'
  if (view.artistId === null) return 'nameless'
  return view.count === 0 ? 'empty' : 'rows'
}
