import type Database from 'better-sqlite3'
import type { DiscoverItem, DiscoverRecipeId, DiscoverShelvesResult } from '@shared/discover'
import { SHELF_MIN_ITEMS } from './constants'
import { dayKey } from './hash'
import { buildTasteSeed } from './seed'
import { emptyClaimed, type Claimed, type Recipe } from './types'
import { forYou } from './recipes/forYou'
import { artists } from './recipes/artists'
import { almostFinished } from './recipes/almostFinished'
import { forgottenFavorites } from './recipes/forgottenFavorites'
import { becauseFavorited } from './recipes/becauseFavorited'
import { guestAppearances } from './recipes/guestAppearances'
import { unplayed } from './recipes/unplayed'
import { neglectedGenre } from './recipes/neglectedGenre'
import { revisit } from './recipes/revisit'

/**
 * Exclusion order. Each recipe receives the album, track and artist ids already
 * claimed. *revisit* is last so it cannot steal an album that is also almost
 * finished or forgotten; *unplayed* sits after the taste-shaped shelves so the
 * remainder is genuinely the rest of the library.
 */
export const EXCLUSION_ORDER: readonly DiscoverRecipeId[] = [
  'for-you',
  'artists',
  'almost-finished',
  'forgotten-favorites',
  'because-favorited',
  'guest-appearances',
  'unplayed',
  'neglected-genre',
  'revisit'
]

const RECIPES: Record<DiscoverRecipeId, Recipe> = {
  'for-you': forYou,
  artists,
  'almost-finished': almostFinished,
  'forgotten-favorites': forgottenFavorites,
  'because-favorited': becauseFavorited,
  'guest-appearances': guestAppearances,
  unplayed,
  'neglected-genre': neglectedGenre,
  revisit
}

/**
 * `(nowMs, library, listens, favorites)` → today's shelves.
 *
 * Pure aside from the reads. Tests call this with a fixture instant and do
 * not go through IPC.
 */
export function compose(db: Database.Database, nowMs: number): DiscoverShelvesResult {
  const seed = buildTasteSeed(db, nowMs)
  const claimed = emptyClaimed()
  const shelves: DiscoverShelvesResult['shelves'] = []

  for (const id of EXCLUSION_ORDER) {
    const recipe = RECIPES[id]
    const output = recipe(db, nowMs, claimed, seed)
    if (output === null) continue
    if (!keepShelf(id, output.items, seed.empty)) continue
    claim(claimed, output.items, output.claimedArtistIds)
    shelves.push({
      id,
      title: output.title,
      hint: output.hint,
      grain: output.grain,
      items: output.items
    })
  }

  return { dayKey: dayKey(nowMs), shelves }
}

function keepShelf(
  id: DiscoverRecipeId,
  items: readonly DiscoverItem[],
  seedEmpty: boolean
): boolean {
  if (items.length === 0) return false
  if (items.length >= SHELF_MIN_ITEMS) return true
  // Cold-start *unplayed* may be the only shelf, and may be thinner than the
  // usual minimum. An empty seed is that cold start.
  return id === 'unplayed' && seedEmpty
}

function claim(
  claimed: Claimed,
  items: readonly DiscoverItem[],
  artistIds: readonly number[] | undefined
): void {
  for (const item of items) {
    if (item.grain === 'album') claimed.albumIds.add(item.albumId)
    else claimed.trackIds.add(item.trackId)
  }
  if (artistIds) for (const artistId of artistIds) claimed.artistIds.add(artistId)
}

/**
 * Memo identity: `(max listens.id, favorites generation, track count, dayKey)`.
 *
 * Favorites have no generation column; count plus the latest `favorited_at`
 * changes on every heart and un-heart, which is the whole of what a toggle
 * does.
 */
export function memoKey(db: Database.Database, nowMs: number): string {
  const listens = db.prepare('SELECT MAX(id) AS id FROM listens').get() as { id: number | null }
  const favorites = db
    .prepare('SELECT COUNT(*) AS n, MAX(favorited_at) AS at FROM track_favorites')
    .get() as { n: number; at: number | null }
  const tracks = db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }
  return [dayKey(nowMs), listens.id ?? 0, favorites.n, favorites.at ?? 0, tracks.n].join('|')
}

/**
 * Production wrapper: same-day opens with no new listens or hearts are a
 * cache hit, not six queries.
 */
export class DiscoverEngine {
  private memo: { key: string; result: DiscoverShelvesResult } | null = null

  constructor(private readonly db: Database.Database) {}

  shelves(nowMs: number = Date.now()): DiscoverShelvesResult {
    const key = memoKey(this.db, nowMs)
    if (this.memo && this.memo.key === key) return this.memo.result
    const result = compose(this.db, nowMs)
    this.memo = { key, result }
    return result
  }

  /** The last `shelves` result, which is what `saveShelf` snapshots. */
  lastResult(): DiscoverShelvesResult | null {
    return this.memo?.result ?? null
  }
}
