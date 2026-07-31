---
taskId: 01KYTKXDK8F31RX58FXN5MNHJ4
title: Related-in-library pane
status: todo
priority: medium
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-5
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 10
created: '2026-07-30T22:56:53.863Z'
updated: '2026-07-30T22:56:53.863Z'
---
## Scope

- Local relatedness only. No network in this card, in this milestone.
- Catalog relations: other albums by this artist, other tracks on this album, compilations the artist appears on.
- A weaker neighbourhood section: same genre, same year, same root folder.

## Acceptance

- Queries answer within frame budget against the synthetic 100k-track library.
- Virtualized, per the standing invariant.
- An artist with genuinely nothing related renders a deliberate empty state, not a pane that looks broken.
- Zero network calls — verifiable, since phase 1 has no network layer at all.

## Notes

The genre neighbourhood is the weak half: genre tags in a scraped library are noisy, and this gets materially better once M3's FTS5 work lands. Build the query behind a seam so a better one can replace it without touching the pane.

Deliberately distinct from the MusicBrainz artist-relations pane, which is a different notion of "related" and lives in M7.
