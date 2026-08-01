import type { Migration } from '../migrate'

/**
 * Podcasts are a separate catalogue from `tracks`.
 *
 * Downloads live under the machine-local podcasts directory (not a library
 * root), referenced only by `episodes.rel_path`. That keeps Library facets
 * music-only and preserves the path invariant: nothing absolute lands here.
 */
export const podcasts: Migration = {
  version: 5,
  name: 'podcasts',
  sql: `
CREATE TABLE podcasts (
  id              INTEGER PRIMARY KEY,
  feed_url        TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  author          TEXT,
  description     TEXT,
  site_url        TEXT,
  artwork_url     TEXT,
  artwork_hash    TEXT,
  subscribed_at   INTEGER NOT NULL,
  last_fetched_at INTEGER,
  last_error      TEXT,
  keep_last       INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE episodes (
  id              INTEGER PRIMARY KEY,
  podcast_id      INTEGER NOT NULL REFERENCES podcasts(id) ON DELETE CASCADE,
  guid            TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  description     TEXT,
  pub_date        INTEGER,
  duration_ms     INTEGER,
  enclosure_url   TEXT    NOT NULL,
  enclosure_type  TEXT,
  enclosure_size  INTEGER,
  rel_path        TEXT,
  downloaded_at   INTEGER,
  file_size       INTEGER,
  download_error  TEXT,
  played          INTEGER NOT NULL DEFAULT 0,
  progress_ms     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(podcast_id, guid)
);

CREATE INDEX episodes_pub_date ON episodes(pub_date DESC);
CREATE INDEX episodes_podcast_pub ON episodes(podcast_id, pub_date DESC);
`
}
