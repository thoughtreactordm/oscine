import type { Migration } from '../../db/migrate'

/**
 * One table. Everything D14 caches is a document keyed by a string, and giving
 * each entity its own table would buy nothing but four copies of the same
 * eviction query.
 *
 * ## `payload IS NULL` is the negative entry
 *
 * A row with a NULL payload records that the service answered and had nothing —
 * R5's unmatchable artist. There is no ambiguity with a document that happens to
 * be null, because a payload is stored as JSON text and JSON's null serialises
 * to the three characters `null`, never to SQL NULL. A separate `outcome` column
 * would be a second source of truth for the same fact.
 *
 * ## Why `used_at` is not `stored_at`
 *
 * Eviction is LRU, so it orders by last read. Keeping the two columns separate
 * means a refresh does not look like recent use and a read does not look like a
 * refresh — which matters because `expires_at` must never move on a read. A
 * cache that renewed its own TTL every time it was read would serve an artist
 * played daily an answer from 2026 forever.
 *
 * ## Indexes
 *
 * The primary key covers every lookup, which is always `(entity, key)` exactly.
 * `idx_cache_entries_used` is the eviction scan; without it, freeing space is a
 * full sort of the table. Nothing indexes `expires_at`: expiry is checked on the
 * row already fetched by the primary key, and the bulk prune runs only inside an
 * eviction that is about to sort the whole table anyway.
 *
 * No foreign key to `tracks` or `artists`, and no reference in the other
 * direction. That is not an oversight — the two databases are separate files,
 * and a cross-file reference is not expressible without an ATTACH that would
 * undo the separation this card exists to create.
 */
export const cacheEntries: Migration = {
  version: 1,
  name: 'cache-entries',
  sql: `
CREATE TABLE cache_entries (
  entity     TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  payload    TEXT,
  size_bytes INTEGER NOT NULL,
  stored_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL,
  PRIMARY KEY (entity, key)
);

CREATE INDEX idx_cache_entries_used ON cache_entries(used_at);
`
}
