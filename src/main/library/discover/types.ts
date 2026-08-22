import type Database from 'better-sqlite3'
import type { DiscoverGrain, DiscoverItem } from '@shared/discover'
import type { TasteSeed } from './seed'

/**
 * What earlier recipes have already put on the page.
 *
 * Computed sequentially in exclusion order. An album (or track) that landed
 * earlier is ineligible later; an artist-picking recipe also claims that
 * artist against later artist-picking recipes.
 */
export interface Claimed {
  albumIds: Set<number>
  trackIds: Set<number>
  artistIds: Set<number>
}

export function emptyClaimed(): Claimed {
  return { albumIds: new Set(), trackIds: new Set(), artistIds: new Set() }
}

export interface RecipeOutput {
  title: string
  hint: string
  grain: DiscoverGrain
  items: DiscoverItem[]
  /** Artist-picking recipes claim the artist they named. */
  claimedArtistIds?: readonly number[]
}

export type Recipe = (
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  seed: TasteSeed
) => RecipeOutput | null
