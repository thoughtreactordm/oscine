---
taskId: 01M126Z037ZH3B7X34PTQRPCGR
title: 'User-tag schema and store: tags + track_tags, rescan-safe'
status: done
priority: high
labels: []
workstream: W15
workstreamId: W15-1
workstreamDependsOn:
  - W2
  - W10
order: 0
created: '2026-08-27T18:15:53.191Z'
updated: '2026-08-28T00:56:42.070Z'
---
The app-side user layer that never touches disk (D7). Foundation for the rest of W15.

## Migration

New migration adding two tables:

```sql
CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,   -- casefold key, SAME fn as track_genres.genre_key
  label      TEXT NOT NULL,          -- display form as first entered
  created_at INTEGER NOT NULL
);

CREATE TABLE track_tags (
  track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)   ON DELETE CASCADE,
  source     TEXT    NOT NULL,       -- 'user' | 'suggested'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, tag_id)
);
CREATE INDEX idx_track_tags_tag ON track_tags(tag_id);
```

## Key invariants

- **Never touches disk (D7).** This is the entire reason the user layer is app-side rather than a mutation of `tracks.genre`. Not a reopening of D7 — a compliance with it.
- **Rescan-safe.** `track_tags` must survive a rescan-upsert. Only the file-derived `track_genres` is rebuilt from `tracks.genre` in the upsert path (see `store.ts` clearTrackGenres/insertTrackGenre); user tags are untouched by scanning. Add a test that upserts a track twice and asserts its user tags persist.
- **Shared identity key.** Reuse `splitGenres`' casefold `genre_key` from `src/shared/genre.ts` as the tag `key` function so file genres and user tags unify (e.g. "Hip-Hop" == "hip hop"). Do not invent a second normalization.

## Store methods (main-process, `src/main/library/` — sibling of track_favorites, not track_overrides)

- `listTags()` -> `{ id, key, label, trackCount }[]`
- `tagsForTrack(trackId)` -> `{ file: string[], user: { id, label, source }[] }` (file = from track_genres, read-only)
- `addTag(trackIds: number[], label, source)` — batch-capable; upserts the vocabulary row by key, then the join rows
- `removeTag(trackIds: number[], tagId)`
- `renameTag(tagId, label)` — vocabulary-wide; re-derives key, merges if it collides with an existing key
- GC: deleting the last `track_tags` row for a tag may leave an orphan `tags` row — decide keep-vocabulary vs prune and document it.

Batch shape (`trackIds: number[]`) is load-bearing for the album/artist apply the Tunedeck pane and suggestions need — build it in from the first commit, not as a later widening.

## Out of scope

IPC surface (next card), any UI, the network suggestion fetch. Just schema + store + tests.
