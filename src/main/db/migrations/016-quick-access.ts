import type { Migration } from '../migrate'

/**
 * Quick-access favorites and the arrival clock — **D24** and **D25**.
 *
 * Two independent facts land together because W13 needs both and neither is
 * large enough to earn its own migration: playlists and artists become
 * favoritable (D24), and `tracks` gains the `indexed_at` column the scanner
 * stamps once on arrival (D25). Retires W12 recorded-debt #1.
 *
 * ## `playlist_favorites` and `artist_favorites` — D24
 *
 * Each mirrors `track_favorites` (015) exactly: the entity id is the `INTEGER
 * PRIMARY KEY` — so "favorited twice" is not a state the schema can hold and the
 * per-row lookup is one b-tree probe — with `ON DELETE CASCADE` and a single
 * `favorited_at` column ordered by an index. D24 turns down a polymorphic
 * `favorites(entity_type, entity_id, ...)` table precisely so these stay the
 * same shape 015 already shipped: a third and fourth table is the same bet D18
 * made and won, and generalizing would rework `track_favorites`, its list paths
 * and three renderer stores for a generality two more tables do not need.
 *
 * The `CASCADE` reasoning is 015's, unchanged: a favorite is a statement about a
 * thing you can still open, and one whose playlist or artist is gone is a broken
 * pinned row, not a memory worth severing to keep. The **star** glyph denotes a
 * favorited playlist or artist; the **heart** stays tracks-only (D24).
 *
 * ## `tracks.indexed_at` — D25, the arrival clock
 *
 * Added nullable, then backfilled — SQLite cannot `ALTER ... ADD COLUMN` a `NOT
 * NULL` column without a constant default, and inventing one would stamp every
 * pre-existing row with the same lie. So the column stays nullable in the schema
 * and the *writer* enforces the invariant: the scanner supplies `indexed_at` on
 * every `INSERT` and omits it from the `(root_id, rel_path)` upsert's `UPDATE`
 * set, so a rescan is never mistaken for an arrival. Stamped once, never on
 * rescan.
 *
 * Existing rows backfill from `roots.added_at` — the coarsest honest answer for
 * a library indexed before this column existed, since the arrival of a root is
 * the nearest thing on record to the arrival of its tracks. `added_at` is `NOT
 * NULL` and every track's `root_id` resolves, so the `COALESCE` fallback to a
 * single migration-time `nowMs` never fires in practice; it is there so the
 * backfill cannot write a `NULL` even if a future schema loosens either fact.
 *
 * `mtime` stays the rescan key and is never read as arrival: a re-tag or a
 * rescan moves the file clock, and ordering "recent" by it would reorder the
 * list wrongly — the precise failure the Discover doc called out. "Recent
 * Additions" orders albums by `MAX(indexed_at)` over their tracks; a track list
 * orders by `indexed_at` directly. `idx_tracks_indexed_at` serves both.
 */
export const quickAccess: Migration = {
  version: 16,
  name: 'quick-access',
  sql: `
CREATE TABLE playlist_favorites (
  playlist_id  INTEGER PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL       -- UTC ms; the rail's default order
);

CREATE INDEX idx_playlist_favorites_at ON playlist_favorites(favorited_at);

CREATE TABLE artist_favorites (
  artist_id    INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL       -- UTC ms; the rail's default order
);

CREATE INDEX idx_artist_favorites_at ON artist_favorites(favorited_at);

-- Nullable in the schema, NOT NULL by the writer's discipline. See the header.
ALTER TABLE tracks ADD COLUMN indexed_at INTEGER;  -- UTC ms; arrival clock (D25)

CREATE INDEX idx_tracks_indexed_at ON tracks(indexed_at);
`,
  /**
   * Derive `indexed_at` for every pre-existing row from its root's `added_at`.
   *
   * A JS step rather than pure `sql` for one reason: the `COALESCE` fallback
   * needs a single consistent `nowMs`, and SQLite's own clock is second
   * resolution and would drift from the UTC-ms convention the column keeps. The
   * fallback is unreachable given today's schema (`roots.added_at` is `NOT NULL`,
   * `tracks.root_id` always resolves); binding one value makes it deterministic
   * regardless.
   */
  backfill: (db) => {
    db.prepare(
      `UPDATE tracks
          SET indexed_at = COALESCE(
                (SELECT added_at FROM roots WHERE roots.id = tracks.root_id),
                ?
              )
        WHERE indexed_at IS NULL`
    ).run(Date.now())
  }
}
