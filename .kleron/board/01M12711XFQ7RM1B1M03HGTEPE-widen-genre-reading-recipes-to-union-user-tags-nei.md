---
taskId: 01M12711XFQ7RM1B1M03HGTEPE
title: >-
  Widen genre-reading recipes to union user tags (Neighbourhood, Discover,
  stats)
status: in-progress
priority: low
labels: []
workstream: W15
workstreamId: W15-6
workstreamDependsOn:
  - W7
  - W10
  - W12
dependsOn:
  - 01M126Z037ZH3B7X34PTQRPCGR
order: 0
created: '2026-08-27T18:17:00.591Z'
updated: '2026-08-27T22:18:42.403Z'
---
The cheap, high-payoff reuse: user tags feed the existing genre machinery, so a tag applied in the pane immediately becomes a browsing and discovery surface.

Because user tags share the casefold key with `track_genres`, the existing genre reads can `UNION` the user layer with little new machinery. Widen each, guarded so a track's own user tags don't make it "related to itself":

- **`relatedSameGenre`** (W7, `src/main/library/store.ts`) — the Tunedeck Neighbourhood "shared genre" strand. Union `track_tags` keys with `track_genres` keys when matching.
- **`neglectedGenre`** discover recipe (W12, `src/main/library/discover/recipes/`) and any other genre-keyed recipe — treat user tags as first-class genre keys.
- **stats "top genres"** GROUP BY (W10) — decide whether user tags count toward the same rollup or a parallel "top tags" dimension; document the choice.

## Guardrails

- One decision to settle and write down: when a file genre and a user tag collide on key, they are the same bucket (that is the point of the shared key) — make sure the union does not double-count a track that has both.
- Each widened query stays within its existing index strategy / the 100k-scale query shape; do not regress `idx_tracks_genre_album`-style plans. Add a note if a new index is needed for the tag side.

## Scope

Read-side only. No new UI. Depends on the schema card for `track_tags`; can land independently of the column and suggestion cards.

## Decisions & outcome (W15-6)

**Where the union landed.** Five genre reads now treat `track_tags` (joined to
`tags` by `tags.key`) as a first-class layer folded onto `track_genres` by the
shared casefold key (`@shared/genre`):

- `relatedSameGenre` (`src/main/library/store.ts`) — the Neighbourhood "genre"
  strand. The file branch is unchanged (still `tracks.genre = @genre` so
  `idx_tracks_genre_album` keeps its early-stop plan); a second `UNION` arm
  matches albums a user hand-tagged with the seed's genre key
  (`@genreKey = normalizeLabel(genre).key`). Same single section, same detail
  label — no new UI. `album_id IS NOT @albumId` on both arms is the "not related
  to itself" guard.
- `buildTasteSeed` (`src/main/library/discover/seed.ts`) — the highest-leverage
  point. `genreListenMs` now unions each played track's file genres and user
  tags, so hand-tagging what you play steers Discover the same way a file genre
  does. `forYou`, `unplayed` and `neglectedGenre` all read this seed, so they
  inherit the widening for free.
- `neglectedGenre` (`.../recipes/neglectedGenre.ts`) — both the album match
  (`EXISTS track_genres OR EXISTS track_tags`) and the pick pool (`pickGenre`
  now `UNION`s the two vocabularies), so a key a user only ever hand-applied is
  a pickable "genre you own and ignore".
- `forYou` and `unplayed` (`.../recipes/`) — the `seedGenre` `EXISTS` gained a
  tag arm on the same key set; `unplayed`'s diversity key falls back to a tag so
  tag-only albums still spread instead of clumping under NULL.

**Collide/no-double-count decision.** A file genre `hip-hop` and a user tag
`Hip-Hop` are one bucket — that is the point of the shared key. Where a count
could double up, it is deduped on the shared identity: the seed unions
`(track_id, key)` before summing listen ms (a track carrying the key in both
vocabularies weights it once); `pickGenre` counts `COUNT(DISTINCT track_id)`;
`relatedSameGenre`'s per-arm album-id subqueries are `UNION`-ed (set, not `ALL`)
and album `trackCount` is still `COUNT` over the album's own tracks, untouched by
tags. Display prefers the file spelling, falling back to the tag label for a
key no file carries.

**Stats "top genres" — parallel dimension, not the same rollup; no code change.**
The stats `genre` dimension groups `listen_genres`, a per-listen *snapshot*
written at play time (migration 014), for the same reason every stats dimension
reads a snapshot. User tags are live current-state with no listen-time snapshot
(there is no `listen_tags`), so unioning them into that rollup would rewrite
history — a tag applied today would appear against every past listen — with no
per-listen ms to attribute. So top-genres stays file-genre-only; a "top tags"
dimension (driven by current `track_tags`, or a future `listen_tags` snapshot)
is a separate, new-UI surface and is out of this read-side card's scope.

**Indexes.** No new index needed. The tag arms resolve `tags.key` through its
`UNIQUE` index to a `tag_id`, then `idx_track_tags_tag` to the assignments;
`track_tags` is user-scale. The file branches keep their existing plans.

**Tests.** `tests/main/library/related.test.ts` (tag-only match, both-vocab
counted once, self-exclusion guard), `.../discover/seed.test.ts` (tag taste
keys, once-per-listen weighting), `.../discover/neglectedGenre.test.ts`
(pure-tag shelf), plus a `tagTracks` fixture helper. Full gate green.
