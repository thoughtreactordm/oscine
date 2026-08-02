import type { Migration } from '../migrate'

/**
 * The resolved MusicBrainz identity, and who decided it.
 *
 * **R5**'s mitigation is one sentence of schema: "store the resolved MBID on the
 * `artists` row so the match is made once per artist rather than once per play".
 * Two columns rather than one, because the identity alone cannot answer the
 * question the acceptance actually asks — whether a later automatic match is
 * allowed to replace what is there.
 *
 * ## `mbid_source` is the whole point
 *
 * `NULL` means nobody has decided. `'auto'` means we matched it, and a better
 * match may replace it — after a rescan renames an artist, or after the search
 * cache expires and MusicBrainz has since merged two entries. `'manual'` means
 * the operator chose, and nothing automatic ever writes over it. That last rule
 * lives in the `UPDATE`'s `WHERE` clause rather than in a service method, so
 * there is no path that forgets it.
 *
 * This is deliberately the same shape as **D7**: the parsed value is what the
 * source said, the correction sits beside it, and the correction wins. The
 * difference is only that D7's source is a tag and this one is a search.
 *
 * `mbid NULL` with `mbid_source = 'manual'` is a real state and not a hole in
 * the model — it is the operator answering "none of these", which has to be
 * durable or the picker reopens on the next play and asks again.
 *
 * ## Why no `checked_at`
 *
 * Because `cache.db` already knows. Whether we have looked, and what the service
 * said when we did, is derived data with a TTL on it; this row records the
 * *answer*. Deleting the cache should mean "look again", and with no timestamp
 * here that is exactly what happens — which is the property W7-8 states as
 * deleting `cache.db` losing nothing but speed.
 *
 * ## The index
 *
 * Partial, because the column is NULL for every artist until something resolves
 * it and a full index would be mostly empty rows. It exists for the direction
 * this query runs in *reverse*: W7-11 intersects MusicBrainz's artist relations
 * with the library, which is a lookup by MBID against every local artist. That
 * is a full scan of `artists` without this, once per relation.
 */
export const artistMbid: Migration = {
  version: 11,
  name: 'artist-mbid',
  sql: `
ALTER TABLE artists ADD COLUMN mbid TEXT;
ALTER TABLE artists ADD COLUMN mbid_source TEXT;

CREATE INDEX idx_artists_mbid ON artists(mbid) WHERE mbid IS NOT NULL;
`
}
