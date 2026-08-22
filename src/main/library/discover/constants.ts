import { SHELF_ITEM_CAP, SHELF_MIN_ITEMS } from '@shared/discover'

export { SHELF_ITEM_CAP, SHELF_MIN_ITEMS }

/** Aim for this many cards; fill to `SHELF_ITEM_CAP` when more of equal quality exist. */
export const SHELF_ITEM_TARGET = 8

export const DAY_MS = 86_400_000

/** Taste-seed window. */
export const RECENT_MS = 30 * DAY_MS

/** Widen the seed to this rather than recommend from one artist. */
export const RECENT_FALLBACK_MS = 90 * DAY_MS

/** Distinct artists the seed wants before it stops widening. */
export const SEED_MIN_ARTISTS = 3

/** Currently in rotation — excluded from *for-you*. */
export const HEAVY_MS = 7 * DAY_MS

/** "A long time ago" for *revisit*. */
export const REVISIT_AGE_MS = 90 * DAY_MS

/** Played, but not a habit. Inclusive with 1. */
export const REVISIT_PLAY_MAX = 3

/** Singles and one-file folders do not fill album shelves. */
export const ALBUM_MIN_TRACKS = 4

/** A discography, not an EP. */
export const DEEP_MIN_ALBUMS = 3

/** Candidate artists for *artists*, by all-time playable listen time. */
export const DEEP_TOP_N = 15

/** Largest genres in the library by track count, for *neglected-genre*. */
export const NEGLECTED_LIBRARY_N = 10

/** Recent-seed genres that are *not* neglected. */
export const NEGLECTED_LISTEN_N = 5
