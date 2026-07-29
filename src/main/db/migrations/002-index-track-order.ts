import type { Migration } from '../migrate'

/**
 * Covers every ordering the library list exposes.
 *
 * The null predicate and final id are part of the index because they are part
 * of the order: unknown values stay last in both directions, while id makes
 * equal values stable across pages. Ascending and descending track indexes are
 * intentionally separate. Reversing one index would reverse the id tie-breaker
 * and move nulls to the front, neither of which matches the public ordering.
 *
 * Artist and album values live in joined tables, so their indexes are consumed
 * by LibraryStore's dimension-first query rather than the ordinary track scan.
 */
export const indexTrackOrder: Migration = {
  version: 2,
  name: 'index-track-order',
  sql: `
CREATE INDEX idx_tracks_order_title_asc
  ON tracks(title IS NULL, title COLLATE NOCASE ASC, id ASC);
CREATE INDEX idx_tracks_order_title_desc
  ON tracks(title IS NULL, title COLLATE NOCASE DESC, id ASC);

CREATE INDEX idx_tracks_order_duration_asc
  ON tracks(duration_ms IS NULL, duration_ms ASC, id ASC);
CREATE INDEX idx_tracks_order_duration_desc
  ON tracks(duration_ms IS NULL, duration_ms DESC, id ASC);

CREATE INDEX idx_tracks_order_number_asc
  ON tracks(
    COALESCE(disc_no, 1) ASC,
    track_no IS NULL,
    track_no ASC,
    id ASC
  );
CREATE INDEX idx_tracks_order_number_desc
  ON tracks(
    COALESCE(disc_no, 1) DESC,
    track_no IS NULL,
    track_no DESC,
    id ASC
  );

CREATE INDEX idx_artists_order_name
  ON artists(name COLLATE NOCASE);
CREATE INDEX idx_albums_order_title
  ON albums(title COLLATE NOCASE);
`
}
