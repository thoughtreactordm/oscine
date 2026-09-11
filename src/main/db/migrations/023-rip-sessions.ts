import type { Migration } from '../migrate'

/**
 * Durable CD-rip sessions — **W18-8**.
 *
 * A full disc at compression level 5 is on the order of ten minutes. Losing
 * track 11 of 12 to a crash means starting over, with the disc still in the
 * drive and no memory of which tracks already landed. These tables are that
 * memory.
 *
 * Rows are written **before** work and updated after — persist first, act
 * second, the same ordering `scrobble_queue` uses under D19 and for the same
 * reason. A track row that says `pending` when the app died is recoverable; a
 * row written only on success is not.
 *
 * ## `toc_hash` is what makes resume safe
 *
 * On resume the drive is re-read and the hash is compared. Continuing against
 * a different disc would interleave two albums into one folder, which is the
 * failure this column exists to prevent. `disc_id` is the MusicBrainz identity
 * of the same TOC; it is stored so the Tools pane can offer the session against
 * the disc that is actually in the drive, but it is not the resume gate.
 *
 * ## Paths are root-relative
 *
 * `rel_dir` and every `rip_session_tracks.rel_path` are POSIX paths relative
 * to `root_id`, like every other library path. There is no exception for
 * bookkeeping tables: an absolute path here would be the same D11 / Windows /
 * Linux break as one in `tracks`.
 *
 * ## This is a log, not an archive
 *
 * Sessions older than 30 days are pruned on startup, and the table is capped.
 * A `running` row is never pruned — that is the crash the operator still has
 * the disc for. Cancelled sessions stay until they age out, for the operator's
 * reference, and are never resumed.
 *
 * No foreign key on `root_id`: a removed root must not take the log with it,
 * and resume against a gone destination is refused in the service, not by a
 * cascade that would hide why.
 */
export const ripSessions: Migration = {
  version: 23,
  name: 'rip-sessions',
  sql: `
CREATE TABLE rip_sessions (
  id            INTEGER PRIMARY KEY,
  disc_id       TEXT    NOT NULL,
  toc_hash      TEXT    NOT NULL,
  release_mbid  TEXT,
  root_id       INTEGER NOT NULL,
  rel_dir       TEXT    NOT NULL,
  template      TEXT    NOT NULL,
  album         TEXT    NOT NULL,
  album_artist  TEXT    NOT NULL,
  year          INTEGER,
  verify        INTEGER NOT NULL CHECK (verify IN (0, 1)),
  state         TEXT    NOT NULL CHECK (state IN ('running', 'cancelled', 'complete', 'failed')),
  created_at    INTEGER NOT NULL,  -- UTC ms
  updated_at    INTEGER NOT NULL   -- UTC ms
);

CREATE TABLE rip_session_tracks (
  session_id   INTEGER NOT NULL REFERENCES rip_sessions(id) ON DELETE CASCADE,
  track_number INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  artist       TEXT    NOT NULL,
  rel_path     TEXT    NOT NULL,  -- root-relative, POSIX
  status       TEXT    NOT NULL CHECK (status IN ('pending', 'written', 'skipped', 'failed', 'verify-failed')),
  sha256       TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error_code   TEXT,
  PRIMARY KEY (session_id, track_number)
);

CREATE INDEX idx_rip_sessions_state_updated ON rip_sessions(state, updated_at);
`
}
