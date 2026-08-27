---
taskId: 01M12711XFQ7RM1B1M03HGTEPE
title: >-
  Widen genre-reading recipes to union user tags (Neighbourhood, Discover,
  stats)
status: backlog
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
order: 15
created: '2026-08-27T18:17:00.591Z'
updated: '2026-08-27T18:17:00.591Z'
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
