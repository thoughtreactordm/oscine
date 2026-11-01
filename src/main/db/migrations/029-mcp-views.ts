import type { Migration } from '../migrate'

/** Epoch milliseconds → ISO 8601 UTC text, or NULL. The read tools' date rule (D36.3). */
const iso = (column: string): string =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} / 1000.0, 'unixepoch')`

/**
 * The `mcp_*` views — **W24-5**, `oscine-mcp` → D36.4.
 *
 * What `query_library` reads, and the only thing it can read: the worker's
 * authorizer (`src/main/mcp/sqlConfinement.ts`) derives its `(table, column)`
 * allowlist from these views when it opens. Two rules follow, and every later
 * view migration is the review point for both:
 *
 * - **A view must not touch a credential or configuration column anywhere** —
 *   select list, join or WHERE — because whatever a view reads, an agent can
 *   read. Nothing here touches `settings`, and `roots` is read for `label` only:
 *   `roots.path` is the one absolute path in the schema and stays unreadable.
 * - **These are a public contract.** An agent's saved query depends on them, so
 *   a change that would break one is a new view (`mcp_tracks_v2`), not an edit.
 *   Adding a column at the end is not breaking. The column documentation an
 *   agent sees is `MCP_VIEWS` in `src/main/mcp/query/views.ts`, which a test
 *   holds equal to what these create.
 *
 * Effective values are the ones the track list shows. Grouped corrections are
 * materialised onto `tracks`/`albums`/`artists` when they are made
 * (`LibraryStore.applyOverride`), so title, artist, album, album artist, numbers
 * and year read through as the list reads them; genre is the one grouped field
 * that is not, and is coalesced here exactly as `find_tracks` does. Registry
 * (`track_tag_overrides`) corrections have no indexed file value to apply to, so
 * they ride as `staged_tags`, a JSON object of field → staged value.
 *
 * Counts are correlated subqueries rather than a grouped join, so a query that
 * does not select them never computes them and a lookup by id stays a lookup.
 *
 * A later migration that rebuilds `tracks` (or any table below) has to drop and
 * recreate these views around the rebuild: SQLite refuses a rename or a drop
 * that would leave a view pointing at nothing.
 */
export const mcpViews: Migration = {
  version: 29,
  name: 'mcp-views',
  sql: `
CREATE VIEW mcp_tracks AS
SELECT
  t.id                 AS id,
  r.label              AS root,
  t.rel_path           AS path,
  t.title              AS title,
  t.artist_id          AS artist_id,
  ar.name              AS artist,
  t.album_id           AS album_id,
  al.title             AS album,
  al.album_artist_id   AS album_artist_id,
  aa.name              AS album_artist,
  t.track_no           AS track_no,
  t.disc_no            AS disc_no,
  al.year              AS year,
  COALESCE(o.year, t.tag_year) AS track_year,
  NULLIF(TRIM(COALESCE(o.genre, t.genre)), '') AS genre,
  t.duration_ms        AS duration_ms,
  t.codec              AS codec,
  t.sample_rate        AS sample_rate,
  t.channels           AS channels,
  t.bit_depth          AS bit_depth,
  t.size               AS size_bytes,
  t.rg_track_gain      AS rg_track_gain,
  t.rg_track_peak      AS rg_track_peak,
  t.rg_album_gain      AS rg_album_gain,
  t.rg_album_peak      AS rg_album_peak,
  t.play_count         AS play_count,
  ${iso('t.last_played_at')} AS last_played_at,
  (fav.track_id IS NOT NULL) AS favorite,
  ((CASE WHEN awo.track_id IS NOT NULL THEN awo.image_hash ELSE al.artwork_hash END)
    IS NOT NULL)       AS has_artwork,
  (o.track_id IS NOT NULL OR awo.track_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM track_tag_overrides x WHERE x.track_id = t.id
  ))                   AS has_corrections,
  (SELECT CASE WHEN COUNT(*) > 0 THEN json_group_object(x.field, json(x.value)) END
     FROM track_tag_overrides x WHERE x.track_id = t.id) AS staged_tags
FROM tracks t
JOIN roots r ON r.id = t.root_id
LEFT JOIN artists ar ON ar.id = t.artist_id
LEFT JOIN albums al ON al.id = t.album_id
LEFT JOIN artists aa ON aa.id = al.album_artist_id
LEFT JOIN track_overrides o ON o.track_id = t.id
LEFT JOIN artwork_overrides awo ON awo.track_id = t.id
LEFT JOIN track_favorites fav ON fav.track_id = t.id;

CREATE VIEW mcp_albums AS
SELECT
  al.id                AS id,
  al.title             AS title,
  al.album_artist_id   AS album_artist_id,
  aa.name              AS album_artist,
  al.year              AS year,
  (al.artwork_hash IS NOT NULL) AS has_artwork,
  (SELECT COUNT(*) FROM tracks x WHERE x.album_id = al.id) AS track_count,
  (SELECT COALESCE(SUM(x.duration_ms), 0) FROM tracks x WHERE x.album_id = al.id) AS duration_ms
FROM albums al
LEFT JOIN artists aa ON aa.id = al.album_artist_id;

CREATE VIEW mcp_artists AS
SELECT
  a.id                 AS id,
  a.name               AS name,
  a.sort_name          AS sort_name,
  a.mbid               AS mbid,
  (SELECT COUNT(*) FROM tracks x WHERE x.artist_id = a.id) AS track_count,
  (SELECT COUNT(*) FROM albums x WHERE x.album_artist_id = a.id) AS album_count
FROM artists a;

CREATE VIEW mcp_playlists AS
SELECT
  p.id                 AS id,
  p.name               AS name,
  p.position           AS position,
  ${iso('p.created_at')} AS created_at,
  ${iso('p.updated_at')} AS updated_at,
  (SELECT COUNT(*) FROM playlist_entries x WHERE x.playlist_id = p.id) AS entry_count
FROM playlists p;

CREATE VIEW mcp_playlist_entries AS
SELECT
  e.id                 AS id,
  e.playlist_id        AS playlist_id,
  e.track_id           AS track_id,
  e.position           AS position
FROM playlist_entries e;

CREATE VIEW mcp_listens AS
SELECT
  l.id                 AS id,
  l.track_id           AS track_id,
  ${iso('l.started_at')} AS started_at,
  l.ms_listened        AS ms_listened,
  l.duration_ms        AS duration_ms,
  l.title              AS title,
  l.artist_name        AS artist,
  l.album_title        AS album,
  l.album_artist_name  AS album_artist
FROM listens l;

CREATE VIEW mcp_track_tags AS
SELECT
  tt.track_id          AS track_id,
  g.label              AS tag,
  g.key                AS tag_key,
  tt.source            AS source,
  ${iso('tt.created_at')} AS added_at
FROM track_tags tt
JOIN tags g ON g.id = tt.tag_id;
`
}
