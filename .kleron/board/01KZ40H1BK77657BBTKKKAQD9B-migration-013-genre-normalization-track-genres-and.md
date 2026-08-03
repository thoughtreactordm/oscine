---
taskId: 01KZ40H1BK77657BBTKKKAQD9B
title: 'Migration 013 — genre normalization: `track_genres` and the splitter'
status: in-review
priority: high
labels:
  - schema
  - library
  - W2-adjacent
workstream: W10
workstreamId: W10-1
order: 59
created: '2026-08-03T14:30:29.491Z'
updated: '2026-08-03T17:50:14.160Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Data model → Migration 013.

**Renumbered from 012.** W11-2's scrobble outbox took 012 because it depends on none of W10's tables and `migrate` refuses a registry with a hole in it. Nothing was released, so the numbers were free to move; the wiki's Data model section records the same thing.

`tracks.genre` (migration 010) is a free `TEXT` column holding whatever the tagger wrote, so `Rock`, `rock` and `Rock; Alternative` are three genres. Genre stats over that are close to noise. This card adds a derived join table so grouping has an identity to group on.

```sql
CREATE TABLE track_genres (
  track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre_key TEXT    NOT NULL,   -- casefolded, trimmed: the grouping identity
  genre     TEXT    NOT NULL,   -- canonical display spelling for that key
  PRIMARY KEY (track_id, genre_key)
) WITHOUT ROWID;

CREATE INDEX idx_track_genres_key ON track_genres(genre_key, track_id);
```

**Derived, never authored.** Rebuilt from `tracks.genre` inside the same upsert that writes a track, so the operator-facing Rescan backfills the whole library with no new gesture — the property migration 010 already relies on. The migration itself should populate from existing `tracks.genre` rows in one pass rather than waiting for a rescan.

**The splitter** separates on `;`, `/` and `,`, trims, collapses internal whitespace, drops empties, and casefolds for `genre_key`. `genre` is the first spelling seen for a key — arbitrary but stable, and better than a title-caser that gets `R&B`, `EDM` and `hip-hop` wrong three different ways. Put it in `src/shared` so a future alias map and the renderer's display path use the same function.

`WITHOUT ROWID` because the primary key *is* the row.

**Accepted cost, do not "fix" it:** `/` is both a real separator and a real character inside genre names, so `Rock/Pop` splits into two. Splitting is right far more often than not. An operator alias map is the answer and is deliberately not in this card.

**Tests** (`tests/main/`): the splitter table-driven — `R&B`, `Hip-Hop/Rap`, `Rock; Alternative`, `  rock  `, empty string, NULL, a tag that is only separators. Plus: upserting a track twice does not accumulate stale genre rows, and deleting a track cascades.

**Done when:** a rescan of a real mixed library populates `track_genres`, `SELECT genre_key, COUNT(*) FROM track_genres GROUP BY genre_key` returns something a human recognises as their genres, and the whole gate passes.
