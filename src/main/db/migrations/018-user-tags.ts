import type { Migration } from '../migrate'

/**
 * User tags — the operator's own layer over the library, and the foundation the
 * rest of W15 is built on. **D7's compliance, not its reopening.**
 *
 * `tracks.genre` and its derived `track_genres` (migrations 010, 013) are what
 * the *file* says. This is what the *operator* says, and D7 is the rule that the
 * two never merge on disk: v1 does not write tags back to the audio file, so a
 * user's correction or classification lives in the database and only there. A
 * user tag is precisely that fact — it cannot be a mutation of `tracks.genre`,
 * because that column is re-read from the file on every rescan and would erase
 * it. So it gets its own tables, which no rescan touches.
 *
 * ## Two tables, because a tag is a shared vocabulary
 *
 * `tags` is the vocabulary — one row per distinct tag the operator has coined,
 * keyed by `key`, the casefold identity `normalizeLabel` produces. That is the
 * *same fold* `track_genres.genre_key` is built from (both call the shared
 * `@shared/genre`), so a user tag `Hip-Hop` and a file genre `hip-hop` collapse
 * to one key and the two vocabularies can be unified by later W15 cards rather
 * than drifting into two spellings of one idea. `key` is `UNIQUE`: coining the
 * same tag twice, however spelled, reuses the row. `label` is the display
 * spelling as first entered — a fact about how the operator wrote it, not a
 * guess about capitalisation, exactly as `track_genres.genre` is.
 *
 * `track_tags` is the assignment — which track carries which tag. `(track_id,
 * tag_id)` is the whole key, so a tag on a track twice is not a state the schema
 * can hold. `source` records whether the operator applied it (`'user'`) or a
 * suggestion did (`'suggested'`, D14, a later card); the column exists now so
 * the suggestion path has somewhere to write without a second migration.
 *
 * ## Rescan-safe, which is the entire point
 *
 * The scanner's write path (`LibraryStore.writeTracks` → `writeTrack`) rebuilds
 * `track_genres` from `tracks.genre` — delete then reinsert — inside its upsert
 * transaction. It never names `track_tags`. So a rescan of a retagged file
 * re-derives its file genres and leaves every user tag exactly where it was.
 * That is a property of what the upsert *does not* touch, asserted by a test
 * that upserts a track twice and reads its tags back unchanged, not of a flag.
 *
 * ## `CASCADE` on both foreign keys
 *
 * A user tag is a statement about a track you can play. One whose track has left
 * the library is a dangling assignment with nothing to render, so `track_tags`
 * cascades when the track goes — the same rule `track_genres` and
 * `track_favorites` take, for the same reason. `track_tags.tag_id` cascades too,
 * so deleting a vocabulary row takes its assignments with it; the store leans on
 * this when a rename merges two tags.
 *
 * The delete rule severs the *assignment*, never the vocabulary: a track leaving
 * the library does not un-coin the tag, which the operator built deliberately
 * and may reapply. Pruning an emptied vocabulary row is a decision the store
 * makes on the explicit remove gesture, documented there — not something the
 * schema does behind a cascade.
 *
 * ## The index
 *
 * `idx_track_tags_tag` leads with `tag_id`, which serves the two reads that go
 * the "who carries this tag" direction — the per-tag track count `listTags`
 * groups on, and the browse-by-tag surface a later card adds. The other
 * direction, "what tags does this track carry", is the primary key's own left
 * edge and needs no index of its own.
 *
 * No backfill. Nothing before this recorded a user tag, and reading one out of
 * `tracks.genre` now would be inventing operator intent from a file's bytes —
 * exactly the merge D7 forbids.
 */
export const userTags: Migration = {
  version: 18,
  name: 'user-tags',
  sql: `
CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,   -- casefold identity: normalizeLabel, the same fold as track_genres.genre_key
  label      TEXT NOT NULL,          -- display spelling, as first entered
  created_at INTEGER NOT NULL        -- UTC ms
);

CREATE TABLE track_tags (
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  source     TEXT    NOT NULL,       -- 'user' | 'suggested'
  created_at INTEGER NOT NULL,       -- UTC ms
  PRIMARY KEY (track_id, tag_id)
);

CREATE INDEX idx_track_tags_tag ON track_tags(tag_id);
`
}
