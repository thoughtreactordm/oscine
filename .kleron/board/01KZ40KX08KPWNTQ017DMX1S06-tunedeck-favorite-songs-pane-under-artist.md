---
taskId: 01KZ40KX08KPWNTQ017DMX1S06
title: Tunedeck — Favorite Songs pane under Artist
status: in-review
priority: medium
labels:
  - ui
  - tunedeck
  - W7-adjacent
  - D18
workstream: W10
workstreamId: W10-8
dependsOn:
  - 01KZ40K4S52HJ267CZEWGD7QH1
order: 50
created: '2026-08-03T14:32:03.336Z'
updated: '2026-08-03T20:44:35.597Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Favorites → "In the Tunedeck".

A "Favorite Songs" pane under the Tunedeck's Artist tab, listing the playing artist's favorited tracks, ordered by `favorited_at` descending.

**It is a local pane and must work with networking declined**, which is D14's third rule and the property M7's exit criterion tests. It reads `track_favorites` joined to `tracks` by `artist_id` and touches nothing remote. Do not make it a child of the artist-nexus panes or gate it on MBID resolution — an artist Fermata cannot resolve remotely still has favorites.

Follow the existing deck panes for shape: same island rules (`src/renderer/panels/tunedeck/`), same virtualization, same behaviour when the deck has no track — W7's recent work made the deck stand down when there is nothing playing and name what it is describing, and this pane inherits both.

**Empty state matters here.** "No favorites from this artist yet" is a normal state for most artists in a large library, not an error, and it should read as an invitation rather than a failure.

Rows activate like any other track row — reuse `trackActivation.ts` / `useTrackActivation.ts` rather than a bespoke handler.

**Done when:** playing a track by an artist with favorites shows them in the deck; playing one by an artist with none shows the empty state; both hold with the network unplugged.
