import type { Migration } from '../migrate'

/**
 * Replaces token/prefix search with literal infix search.
 *
 * The migration runner wraps this whole script and the user_version bump in one
 * transaction. A crash therefore leaves either the old complete index or this
 * rebuilt complete index, never an empty table presented as current.
 *
 * Metadata-only triggers keep the contentless index in sync. They deliberately
 * do not fire for ReplayGain, play-count or rating updates.
 */
export const trigramSearch: Migration = {
  version: 4,
  name: 'trigram-search',
  sql: `
DROP TABLE tracks_fts;

CREATE VIRTUAL TABLE tracks_fts USING fts5(
  title, artist, album,
  content='',
  tokenize='trigram case_sensitive 0 remove_diacritics 1'
);

INSERT INTO tracks_fts(rowid, title, artist, album)
SELECT t.id, COALESCE(t.title, ''), COALESCE(ar.name, ''), COALESCE(al.title, '')
FROM tracks t
LEFT JOIN artists ar ON ar.id = t.artist_id
LEFT JOIN albums al ON al.id = t.album_id;

CREATE TRIGGER tracks_fts_after_insert
AFTER INSERT ON tracks
BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album)
  SELECT NEW.id, COALESCE(NEW.title, ''), COALESCE(ar.name, ''), COALESCE(al.title, '')
  FROM (SELECT 1)
  LEFT JOIN artists ar ON ar.id = NEW.artist_id
  LEFT JOIN albums al ON al.id = NEW.album_id;
END;

CREATE TRIGGER tracks_fts_before_delete
BEFORE DELETE ON tracks
BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
  SELECT 'delete', OLD.id, COALESCE(OLD.title, ''), COALESCE(ar.name, ''), COALESCE(al.title, '')
  FROM (SELECT 1)
  LEFT JOIN artists ar ON ar.id = OLD.artist_id
  LEFT JOIN albums al ON al.id = OLD.album_id;
END;

CREATE TRIGGER tracks_fts_before_metadata_update
BEFORE UPDATE OF title, artist_id, album_id ON tracks
BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album)
  SELECT 'delete', OLD.id, COALESCE(OLD.title, ''), COALESCE(ar.name, ''), COALESCE(al.title, '')
  FROM (SELECT 1)
  LEFT JOIN artists ar ON ar.id = OLD.artist_id
  LEFT JOIN albums al ON al.id = OLD.album_id;
END;

CREATE TRIGGER tracks_fts_after_metadata_update
AFTER UPDATE OF title, artist_id, album_id ON tracks
BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album)
  SELECT NEW.id, COALESCE(NEW.title, ''), COALESCE(ar.name, ''), COALESCE(al.title, '')
  FROM (SELECT 1)
  LEFT JOIN artists ar ON ar.id = NEW.artist_id
  LEFT JOIN albums al ON al.id = NEW.album_id;
END;

CREATE INDEX idx_tracks_root_artist ON tracks(root_id, artist_id, id);
CREATE INDEX idx_tracks_root_album ON tracks(root_id, album_id, id);
CREATE INDEX idx_tracks_artist_album ON tracks(artist_id, album_id, id);
`
}
