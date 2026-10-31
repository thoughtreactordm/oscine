import type { Migration } from '../migrate'

/**
 * Two scan facts the index used to drop — **W24-4**, `oscine-mcp` → D36.4.1.
 *
 * `find_issues` checks for missing album artists and for years that disagree
 * within an album, and neither question could be answered from what the scanner
 * kept:
 *
 * - A file with no ALBUMARTIST is grouped under its performer (the compilation
 *   rule in `writeTrack`), so `albums.album_artist_id` is set either way and the
 *   absence of the tag left no trace.
 * - Year lives on `albums`, filled first-wins, so a second track carrying a
 *   different year changed nothing.
 *
 * `tag_album_artist` is 1 when the file had an album-artist tag and 0 when it
 * did not; `tag_year` is the file's own year. Both are written by every parse
 * and read by nothing on the browse path.
 *
 * **No backfill**, because there is nothing honest to backfill from: the files
 * were read before these columns existed. NULL means "not re-read since 028",
 * and the checks skip those rows and report how many there are. The operator's
 * Rescan re-reads every file (an explicit rescan is a force-parse), which is
 * the gesture that fills them.
 */
export const trackScanFacts: Migration = {
  version: 28,
  name: 'track-scan-facts',
  sql: `
ALTER TABLE tracks ADD COLUMN tag_album_artist INTEGER;
ALTER TABLE tracks ADD COLUMN tag_year INTEGER;
`
}
