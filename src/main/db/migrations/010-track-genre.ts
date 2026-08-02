import type { Migration } from '../migrate'

/**
 * Genre, and the three indexes the related pane's neighbourhood half needs.
 *
 * ## Why genre is a column at all
 *
 * The standing argument against widening `tracks` — made at length on
 * `TrackFormatDetail`, which stayed out of the schema for exactly this reason —
 * is that a column nothing filters or sorts on buys nothing but a rescan. Genre
 * is the other case: the neighbourhood strand *is* a filter over it, run against
 * a hundred thousand rows, and re-parsing a tag per candidate track is not a
 * query. So it is indexed, and the cost is the honest one below.
 *
 * ## The cost, stated plainly
 *
 * `ALTER TABLE ... ADD COLUMN` leaves the column NULL for every already-indexed
 * track, and nothing backfills it: the value lives in the file's tags and the
 * only way back to it is to read the file. Until a root is rescanned, its
 * tracks have no genre and the genre strand is simply absent for them — which
 * is the same thing the pane already renders for a track whose file never
 * carried a genre tag, so no code path is special-cased for the migration. A
 * rescan is `library.scanRoot`; incremental rescan skips unchanged files by
 * mtime, so operators will need a forced rescan to pick genre up on a library
 * that has not changed. That is a real operational cost and it is why W7-5 grew
 * a migration rather than shipping the strand as a stub.
 *
 * ## Why TEXT rather than a `genres` table
 *
 * Genre is the strand the card itself calls the weak half — scraped tags are
 * noisy, inconsistent and frequently multi-valued — and normalising a noisy
 * dimension buys referential tidiness for data that does not deserve it. A
 * denormalised string with a covering index answers the one query that exists.
 * When M3's FTS5 work lands, the strand is replaced behind the seam in
 * `library/related.ts` rather than reshaped here.
 *
 * ## The indexes
 *
 * `(genre, album_id)` and not `(genre)`: the query groups by album inside a
 * limited subquery, so a composite index lets SQLite walk equal-genre entries
 * already ordered by album and stop at the limit. With a bare `(genre)` index
 * the same query collects every matching row into a temporary b-tree first,
 * which for a broad genre is the whole point of the limit defeated.
 *
 * `albums(album_artist_id)` exists because `UNIQUE(title, album_artist_id)`
 * leads with the title and so cannot serve a lookup by artist — the discography
 * strand would be a full scan of `albums` without it.
 *
 * No index for the folder strand: it is a prefix range over `rel_path`, which
 * the `UNIQUE(root_id, rel_path)` index already serves.
 */
export const trackGenre: Migration = {
  version: 10,
  name: 'track-genre',
  sql: `
ALTER TABLE tracks ADD COLUMN genre TEXT;

CREATE INDEX idx_tracks_genre_album ON tracks(genre, album_id);
CREATE INDEX idx_albums_artist ON albums(album_artist_id);
CREATE INDEX idx_albums_year ON albums(year);
`
}
