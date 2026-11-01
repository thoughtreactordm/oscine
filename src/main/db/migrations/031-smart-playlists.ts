import type { Migration } from '../migrate'

/**
 * Smart playlists — **W24-9**, `oscine-mcp` → D36.8.
 *
 * A smart playlist is an ordinary playlist flagged as one any agent may keep up
 * to date when the operator asks. Nothing here is evaluated: the app never
 * refreshes one on its own (D36), and with no agent it is a playlist with a
 * badge.
 *
 * - `kind` is `'static'` or `'smart'` — an enum rather than a boolean, so a
 *   rule-evaluated kind can be added later without another column.
 * - `brief` is the operator's description of what belongs; `agent_notes` is
 *   the agent's scratch (the query it used, what it ruled out), read first by
 *   whichever agent comes next. `refreshed_at` is when an agent last added to
 *   it or rewrote its notes (UTC ms).
 * - `playlist_exclusions` holds the tracks kept out: the operator removing a
 *   track from a smart playlist, or an agent removing one with `exclude`. An
 *   agent's add skips them; the operator adding one back by hand clears it.
 *   `source` is `'operator'` or `'agent'`.
 *
 * Carried by the export bundle with the playlist (`src/main/bundle/tables.ts`).
 */
export const smartPlaylists: Migration = {
  version: 31,
  name: 'smart-playlists',
  sql: `
ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'static'
  CHECK (kind IN ('static', 'smart'));
ALTER TABLE playlists ADD COLUMN brief TEXT;
ALTER TABLE playlists ADD COLUMN agent_notes TEXT;
ALTER TABLE playlists ADD COLUMN refreshed_at INTEGER;

CREATE TABLE playlist_exclusions (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL CHECK (source IN ('operator', 'agent')),
  created_at  INTEGER NOT NULL,          -- UTC ms
  PRIMARY KEY (playlist_id, track_id)
) WITHOUT ROWID;

CREATE INDEX idx_playlist_exclusions_track ON playlist_exclusions(track_id);
`
}
