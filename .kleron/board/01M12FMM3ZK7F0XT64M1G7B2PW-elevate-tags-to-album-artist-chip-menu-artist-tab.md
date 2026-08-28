---
taskId: 01M12FMM3ZK7F0XT64M1G7B2PW
title: >-
  Elevate tags to album/artist: chip menu + Artist-tab Tags pane
  (union+coverage)
status: done
priority: low
labels: []
workstream: W15
workstreamId: W15-7
workstreamDependsOn:
  - W7
dependsOn:
  - 01M126ZRER5HXPM5TY9EYKKMJS
  - 01M126ZBGXQZ8QTJ9W6E5N2CBS
order: 6
created: '2026-08-27T20:47:30.431Z'
updated: '2026-08-28T00:56:42.135Z'
---
Raise a tag's altitude: from the one track it was applied to, up to the containing album or the whole artist — and give the Artist tab its own view of what the operator has tagged across a catalog. Two sizes of one feature; built together.

Not to be confused with **W15-6** (read-side `UNION` of user tags into the genre machinery — Neighbourhood/Discover/stats). This card is the *edit/altitude* surface, and the "union" here is a per-artist coverage aggregation for display, not a SQL rewrite of the genre reads.

## A. Chip elevate menu (Track-tab pane)

On each editable user-tag chip in `TagsPane.vue`, a menu (`UDropdownMenu`/`UContextMenu`, matching `FacetList`/`DiscoverPane` idiom) with:

- **Apply to this album** — disabled when `facets.albumId == null`
- **Apply to everything by <artist>** — disabled when `facets.artistId == null`

Reuses `resolveScopeTrackIds` + `tags.add(ids, label)` already in the pane; `tags.add` is an idempotent upsert so re-covering the seed track is a no-op. The chip's ✕ stays track-only (remove is not scoped — a remove that reached an album would be a destructive gesture wearing a one-row ✕). Fix the suggestion chip's hardcoded "add to this track" aria/title to reflect the active `Add to` scope while here.

## B. Artist-tab Tags pane — union + coverage

A new `artist` group, sibling to `artist-favorites` / `artist-listening` (the offline "operator's-own-record" trio; seeded by the playing track, answered from SQLite, works with lookups declined). Shows **every tag used anywhere in the artist's catalog**, each with a **coverage** count (`carried / total`, e.g. 18/40). Per-tag actions: **apply to all** (fill coverage) and **remove from all**. A tag at full coverage is, in effect, "an artist tag."

### New main-side query (contract-first, per invariants)

Coverage cannot be computed from N per-track `forTrack` calls. Add a new `tags.*` channel starting in `src/shared/ipc.ts` (+ `src/shared/tags.ts` shapes), through preload → renderer `ipc.ts` → renderer tags store → pane:

- `tags.forArtist({ artistId })` → `{ total, tags: { id, key, label, carried }[] }`
- `artistId` is the browse-dimension id (`COALESCE(album_artist_id, artist_id)`), the same one `trackFacets(trackId).artistId` returns and `listTrackIds({ artistIds })` selects on, so the pane's subject matches the Track pane's artist batch exactly.
- One grouped join (tracks-in-artist ⋈ track_tags ⋈ tags), `GROUP BY tag`; `total` = the artist's track count. Stay within the existing artist-scope query shape/index; note if a new index is needed.

### Notes / guardrails

- **Not virtualized.** The list is bounded by vocabulary (dozens), not the 100k track-scale the virtualization invariant targets — a chip cluster like the existing pane, not a `TrackList`. (Called out so it is a decision, not an oversight.)
- Badge counts tags with any coverage in the artist (`countArtistTags`), on the same `showing`-gated trigger the deck's other badges use.
- Editorial voice: a `hint` in the register of the surrounding groups — what it is, that it is the operator's own record, that it works offline.
- Keep the two panes naming the concept identically (coordinate with W15-5's column label too).

## Out of scope

The TrackList column/browse-by-tag (W15-5), the read-side genre union (W15-6), the MB suggestion fetch (W15-4).
