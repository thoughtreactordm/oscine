import type { Migration } from '../migrate'

/**
 * The play-history trail (W7-4). Append-only, capped, evicted from the bottom.
 *
 * Three columns and no more. Which scope a track played from is deliberately
 * not recorded: jump-back is a *detour* rather than a return to a scope — it
 * queues the row and plays it out of turn, leaving `playingPlaylistId`, the
 * order and the resume position exactly where they were (§5 rules 1 and 2) — so
 * a stored scope would be a column nothing reads, that goes stale when a
 * playlist is edited, and that would have to be reconciled when it is deleted.
 *
 * `ON DELETE CASCADE`, because a trail row that cannot be played is not worth
 * keeping. The cascade is quiet in practice: an incremental rescan upserts
 * `tracks` on `(root_id, rel_path)` and only deletes a row when its file is
 * genuinely gone from the root. A file *moved* between roots or folders reads
 * as a delete plus an insert, so its history does go with it — the honest cost
 * of not denormalising a title into every row.
 *
 * The index is the child side of that cascade. SQLite indexes the parent of a
 * reference automatically and never the child, so without it every track
 * deletion during a scan is a full scan of this table.
 *
 * No index on `played_at`: the trail is read `ORDER BY id DESC`, which is the
 * rowid, and eviction deletes a contiguous range of it.
 */
export const playHistory: Migration = {
  version: 9,
  name: 'play-history',
  sql: `
CREATE TABLE play_history (
  id        INTEGER PRIMARY KEY,
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  played_at INTEGER NOT NULL
);

CREATE INDEX idx_play_history_track ON play_history(track_id);
`
}
