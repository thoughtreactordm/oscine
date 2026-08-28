import type { Migration } from '../migrate'

/**
 * `track_overrides` gains `genre` and `year` — **W16-1**.
 *
 * D7's override table (migration 001) carries the operator's per-track
 * corrections for title/artist/album/track/disc, the reversible working surface
 * that D28's write-back path flushes to file tags. Genre and year were never on
 * it because nothing wrote them: the genre correction layer was the file-derived
 * `track_genres` union with W15's user tags, and year had no correction surface
 * at all.
 *
 * D28 changes that. The pending-write diff (W16-1) merges these override columns
 * ahead of every other layer, so genre and year need a home at the same
 * precedence as the rest — an explicit scalar override that replaces the file's
 * value the way `title` already does. Both are nullable and default to absent, so
 * an existing database gains two empty columns and no track's merged value moves
 * until the operator sets one.
 *
 * `genre` is TEXT rather than a join like `track_genres`: it is one authored
 * correction string, split into the file's genre frame by the same `splitGenres`
 * rule the scanner uses, not a pre-split set. `year` is INTEGER to match
 * `TrackTags.year` and the `tracks` table's numeric release-year handling.
 */
export const trackOverridesGenreYear: Migration = {
  version: 19,
  name: 'track-overrides-genre-year',
  sql: `
    ALTER TABLE track_overrides ADD COLUMN genre TEXT;
    ALTER TABLE track_overrides ADD COLUMN year INTEGER;
  `
}
