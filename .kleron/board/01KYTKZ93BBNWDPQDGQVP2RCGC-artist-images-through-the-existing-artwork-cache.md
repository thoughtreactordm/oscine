---
taskId: 01KYTKZ93BBNWDPQDGQVP2RCGC
title: Artist images through the existing artwork cache
status: todo
priority: medium
labels:
  - M7
  - phase-2
  - library
workstream: W7
workstreamId: W7-13
workstreamDependsOn:
  - W2
dependsOn:
  - 01KYTKYEBY8CPQ08PBS15WGN9R
order: 18
created: '2026-07-30T22:57:54.794Z'
updated: '2026-07-30T22:57:54.794Z'
---
## Scope

- Wikidata/Commons image for a resolved artist, stored in the **existing** content-hashed thumbnail cache rather than a second blob store.
- Attribution captured alongside the image, since Commons licences require it at display time.

## Acceptance

- Image renders in the deck's artist header.
- Eviction is shared with album artwork and does not preferentially evict album art — album art is load-bearing for the whole UI, artist images are decoration.
- Commons attribution is displayed wherever the image is.
- A missing or 404 image is a normal empty state.
- Images honour the consent gate exactly as text does.

## Notes

The one place phase 2 reaches into W2's territory. Coordinate the eviction policy with the artwork cache's owner rather than bolting a parallel one alongside it — two caches with two policies competing for the same disk budget is the failure mode here.
