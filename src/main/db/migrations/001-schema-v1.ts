import type { Migration } from '../migrate'

/**
 * Schema v1, transcribed from design section 4.
 *
 * It lands whole even though M1 only exercises `roots` and `tracks`. The columns
 * W3 and W5 need — ReplayGain, ratings, playlist ordering — cost nothing empty,
 * and adding them later would cost a migration each.
 *
 * Kept as a SQL string in a TypeScript module rather than a `.sql` file on disk
 * because electron-vite bundles main into a single file: a sibling `.sql` would
 * not be copied into `out/`, and would fail only in the packaged build.
 */
export const schemaV1: Migration = {
  version: 1,
  name: 'schema-v1',
  sql: `
CREATE TABLE roots (
  id           INTEGER PRIMARY KEY,
  label        TEXT    NOT NULL,
  path         TEXT    NOT NULL UNIQUE,  -- absolute, machine-local
  added_at     INTEGER NOT NULL,
  last_scan_at INTEGER
);

CREATE TABLE artists (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  sort_name TEXT
);

CREATE TABLE albums (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  album_artist_id INTEGER REFERENCES artists(id),
  year            INTEGER,
  artwork_hash    TEXT,                  -- key into on-disk thumbnail cache
  UNIQUE(title, album_artist_id)
);

CREATE TABLE tracks (
  id             INTEGER PRIMARY KEY,
  root_id        INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path       TEXT    NOT NULL,       -- POSIX-normalised, relative to root
  mtime          INTEGER NOT NULL,       -- incremental rescan key
  size           INTEGER NOT NULL,
  duration_ms    INTEGER,
  codec          TEXT,                   -- flac | mp3 | vorbis | opus | aac
  sample_rate    INTEGER,
  channels       INTEGER,
  bit_depth      INTEGER,
  title          TEXT,
  artist_id      INTEGER REFERENCES artists(id),
  album_id       INTEGER REFERENCES albums(id),
  track_no       INTEGER,
  disc_no        INTEGER,
  rg_track_gain  REAL,                   -- dB
  rg_track_peak  REAL,
  rg_album_gain  REAL,
  rg_album_peak  REAL,
  rg_source      TEXT,                   -- 'tag' | 'computed' | NULL
  play_count     INTEGER NOT NULL DEFAULT 0,
  last_played_at INTEGER,
  rating         INTEGER,
  UNIQUE(root_id, rel_path)
);

-- D7: corrections live here and never touch the file on disk.
CREATE TABLE track_overrides (
  track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  title       TEXT,
  artist_name TEXT,
  album_title TEXT,
  track_no    INTEGER,
  disc_no     INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE playlists (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  position     INTEGER NOT NULL,         -- tab order
  crossfade_ms INTEGER NOT NULL DEFAULT 0,  -- R2 policy
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE playlist_entries (
  id          INTEGER PRIMARY KEY,       -- stable across reordering
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    REAL    NOT NULL           -- fractional: O(1) insert between
);

CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, artist, album,
  content='', tokenize='unicode61 remove_diacritics 2'
);

-- Indexes are not in design section 4, which specifies tables. These follow
-- directly from the foreign keys above: SQLite indexes the parent side of a
-- reference automatically but never the child side, so every ON DELETE CASCADE
-- and every "entries for this playlist" lookup would otherwise be a full scan.
CREATE INDEX idx_tracks_root ON tracks(root_id);
CREATE INDEX idx_tracks_album ON tracks(album_id);
CREATE INDEX idx_tracks_artist ON tracks(artist_id);
CREATE INDEX idx_playlist_entries_playlist ON playlist_entries(playlist_id, position);
CREATE INDEX idx_playlist_entries_track ON playlist_entries(track_id);
`
}
