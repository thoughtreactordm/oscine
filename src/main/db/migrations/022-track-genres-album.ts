import type { Migration } from '../migrate'

/**
 * Denormalize `album_id` onto `track_genres` so genre-roulette's pool gate stops
 * scanning the library — **W12-8**.
 *
 * ## Why the column exists
 *
 * Every Discover recipe but one is taste- or claim-scoped and touches a few
 * thousand rows. `genre-roulette` (W12-6) is the exception: it picks the day's
 * genre from a *library-wide* candidate pool, so its pool gate has to bucket
 * genres by album — and `track_genres(track_id, genre_key)` carries no
 * `album_id`, forcing a `JOIN tracks ON tracks.id = track_genres.track_id` over
 * every genre row to recover it. Both sides are already optimally indexed by
 * `track_id`; the cost is the cross-table correlation itself, not a missing
 * index, so no index over the existing columns removes it. At the 100k-track
 * scale target that correlation is ~35 ms and pushed `compose` p95 past the
 * 250 ms tab-open budget.
 *
 * Mirroring `tracks.album_id` here turns the gate into an index-only walk of
 * `idx_track_genres_key_album`: `GROUP BY genre_key … COUNT(DISTINCT album_id)`
 * never touches `tracks`. The column is nullable because `tracks.album_id` is —
 * a track with no album contributes a NULL here, which the recipe's
 * `album_id IS NOT NULL` gates discard exactly as before.
 *
 * ## Keeping it in sync
 *
 * `track_genres` is derived: `LibraryStore.writeTrack` rebuilds a track's rows
 * (delete then insert) in the scan transaction, and that insert now carries the
 * track's `album_id` directly. But two W16 write-back paths — `applyOverride`
 * and `revertOverride` — retarget `tracks.album_id` *without* rebuilding
 * `track_genres`, and a denormalized copy they never touch would silently
 * desync. Rather than make every present and future writer of `tracks.album_id`
 * remember this column, the invariant is schema-owned: a trigger mirrors any
 * real change of `tracks.album_id` into the track's genre rows. `WHEN
 * NEW.album_id IS NOT OLD.album_id` keeps it off the hot path — a rescan upsert
 * that rewrites the row with an unchanged album fires nothing, and where the
 * album *does* change the following delete-then-insert would land the same value
 * regardless, so the trigger only has to cover the write-back edits that skip
 * the rebuild.
 *
 * `track_genres` is `WITHOUT ROWID`; `ADD COLUMN` and the one-pass backfill are
 * both supported on it.
 */
export const trackGenresAlbum: Migration = {
  version: 22,
  name: 'track-genres-album',
  sql: `
ALTER TABLE track_genres ADD COLUMN album_id INTEGER;  -- mirrors tracks.album_id (W12-8)

-- Leads with genre_key and carries album_id, so the pool gate's
-- "GROUP BY genre_key … COUNT(DISTINCT album_id)" is an index-only scan.
CREATE INDEX idx_track_genres_key_album ON track_genres(genre_key, album_id);

-- The sync invariant, owned by the schema rather than by every writer of
-- tracks.album_id. WHEN-guarded so an unchanged rewrite (the scan upsert) is a
-- no-op; a real retarget from write-back is mirrored onto the track's rows.
CREATE TRIGGER track_genres_album_sync
AFTER UPDATE OF album_id ON tracks
WHEN NEW.album_id IS NOT OLD.album_id
BEGIN
  UPDATE track_genres SET album_id = NEW.album_id WHERE track_id = NEW.id;
END;
`,
  backfill: (db) => {
    // One correlated UPDATE: cheaper than reading rows into JS, and the whole
    // migration runs in a single transaction, so a failure rolls the column back
    // out with user_version untouched.
    db.exec(
      `UPDATE track_genres
          SET album_id = (SELECT t.album_id FROM tracks t WHERE t.id = track_genres.track_id)`
    )
  }
}
