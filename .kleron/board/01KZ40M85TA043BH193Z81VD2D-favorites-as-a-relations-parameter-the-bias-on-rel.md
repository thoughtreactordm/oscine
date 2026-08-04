---
taskId: 01KZ40M85TA043BH193Z81VD2D
title: Favorites as a relations parameter — the bias on `related.ts`
status: done
priority: low
labels:
  - main
  - tunedeck
  - W7-adjacent
  - D18
workstream: W10
workstreamId: W10-9
dependsOn:
  - 01KZ40K4S52HJ267CZEWGD7QH1
order: 7
created: '2026-08-03T14:32:14.778Z'
updated: '2026-08-04T15:06:58.922Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Favorites → "As a relations parameter".

**Scoped to part 1.** The card carried two things and said what to do if the second was not reachable: *"This card depends on W7's nexus existing for part 2. If it does not yet, land part 1 and split part 2 out rather than blocking."* It does not — `nexus` appears nowhere in `src/` — so the annotation is now W10-15 and this card is `related.ts` alone.

**What landed.** `FavoriteBias` in `src/shared/related.ts`: `ignore | prefer | only`, optional on `RelatedQuery`, defaulted in `buildRelated`, forwarded by `getRelated`. All six strands take it, not the two the spec's example names — a pane that preferred favorites in "more from this artist" and ignored them one heading down would be describing its own implementation rather than the request.

**One tri-state, not the filter-and-weighting pair the spec names.** The fourth state that pair admits — "only favorites, and put the favorites first" — is not a mode: under `only` every row is already a favorite.

**Rank, not score**, as the card asked: favorited first, then exactly what the strand already ordered by.

**Off by default is a property of the SQL text, not a promise.** One prepared statement per strand with two bound integers; with both zero every fragment collapses to a constant and SQLite's `OR`/`CASE` short-circuiting means no correlated subquery is even entered. The compatibility test captures the unbiased result *before* any favorite exists and compares it against the unbiased result once two do — a version run against a library with no favorites would pass on a query that had forgotten the parameter entirely.

**Filter inside the candidate subquery, rank outside**, on the three strands that have one. The filter has to be inside because the `LIMIT` is; the rank has to be outside because putting it inside would mean ordering the whole genre, which is the one thing those subqueries exist to avoid.

**One honest limit, recorded rather than hidden.** `prefer` reorders and does not narrow, so where a strand's matches fit inside `RELATED_SECTION_LIMIT` it is exactly a permutation. Where a strand is truncated, promoting a favorite to the top of a full page pushes something off the bottom — unavoidable, and `truncated` was already true for precisely those strands.

**Not done here:** no UI affordance and no setting. Nothing in the app turns the bias on yet, which is why existing behaviour is unchanged; the pane toggle is a UI decision no card specifies.

**Done when:** ~~a related pane with weighting on puts hearted tracks first without dropping anything it showed before, and the nexus shows a favorites count against similar artists offline.~~ Weighting puts hearted rows first without dropping anything the page showed before, proved at the SQL against a real library. The nexus half is W10-15.
