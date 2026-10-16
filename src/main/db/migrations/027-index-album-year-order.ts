import type { Migration } from '../migrate'

/**
 * The Year column's ordering, read straight off `albums`.
 *
 * The year sort orders by year, then album title, then album id, then playing
 * order within the album. The first three are album columns — the id is the
 * rowid every index already ends in — so these indexes hand the joined-sort
 * query each album in final position and SQLite only sorts the tracks inside
 * one album, as it does for the Album column. On `idx_albums_year` alone it
 * sorted every year's tracks together: double the deep-page budget at 100k.
 *
 * Two indexes for migration 002's reason: the title holds ascending however the
 * years run, so a reverse scan of one index would reverse the titles with them.
 *
 * On `albums`, not `tracks`, so the write cost is paid once per album rather
 * than once per track. `idx_albums_year` stays: the ascending index could serve
 * the related-albums year lookup too, but dropping it would change that query's
 * plan for no gain worth having on a table this size.
 */
export const indexAlbumYearOrder: Migration = {
  version: 27,
  name: 'index-album-year-order',
  sql: `
CREATE INDEX idx_albums_order_year_asc
  ON albums(year ASC, title COLLATE NOCASE ASC);
CREATE INDEX idx_albums_order_year_desc
  ON albums(year DESC, title COLLATE NOCASE ASC);
`
}
