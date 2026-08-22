import { FermataError } from '@shared/errors'
import type { DiscoverItem, DiscoverRecipeId, DiscoverShelvesResult } from '@shared/discover'

/**
 * Save-as-playlist is a snapshot of the wall the operator is looking at.
 *
 * `discover.saveShelf` must not re-run compose: a later listen, a heart, or
 * even the same clock with a different library would pick different cards, and
 * the playlist would quietly disagree with the strip. The last `shelves`
 * result is the one that was drawn.
 */

export interface DiscoverShelfSnapshot {
  name: string
  items: DiscoverItem[]
}

/** `{shelf.title} · {dayKey}` — a dated snapshot, not a live collection. */
export function shelfPlaylistName(title: string, dayKey: string): string {
  return `${title} · ${dayKey}`
}

/**
 * The named shelf from the last `shelves` result, or `not-found`.
 *
 * A valid recipe id that is simply not on today's page — omitted as thin, or
 * a refetch that dropped it — is the same code as "nothing has been composed
 * yet". The recipe was valid (the validator already said so); the snapshot is
 * what is missing.
 */
export function snapshotShelf(
  last: DiscoverShelvesResult | null,
  recipeId: DiscoverRecipeId
): DiscoverShelfSnapshot {
  if (last === null) {
    throw new FermataError('not-found', 'Discover has no shelf to save yet.')
  }
  const shelf = last.shelves.find((entry) => entry.id === recipeId)
  if (shelf === undefined) {
    throw new FermataError('not-found', "That shelf is not on today's page.")
  }
  return { name: shelfPlaylistName(shelf.title, last.dayKey), items: shelf.items }
}

/**
 * Flatten a shelf to track ids, in card order.
 *
 * Album cards expand through the caller so the order is Library's disc / track
 * / id playing order — the same `trackNo` sort a Library album activation
 * uses — rather than a second builder. Track cards are the id they already
 * named. Missing files drop out of the album expansion; a vanished track-grain
 * id is left for the caller to drop when it hydrates.
 */
export function expandShelfTrackIds(
  items: readonly DiscoverItem[],
  albumTrackIds: (albumId: number) => readonly number[]
): number[] {
  const ids: number[] = []
  for (const item of items) {
    if (item.grain === 'track') ids.push(item.trackId)
    else ids.push(...albumTrackIds(item.albumId))
  }
  return ids
}
