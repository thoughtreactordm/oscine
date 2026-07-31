---
taskId: 01KYTKX6KVWZ5K9055BCMFSFBY
title: Play history trail — store and pane
status: todo
priority: medium
labels:
  - M5
  - phase-1
  - library
workstream: W7
workstreamId: W7-4
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 9
created: '2026-07-30T22:56:46.714Z'
updated: '2026-07-30T22:56:46.714Z'
---
## Scope

- A main-process play-history store that does not exist yet: append-only, with a stated cap or time window.
- Schema migration for the table, plus IPC to read recent plays.
- A reverse-chronological deck pane with jump-back.

## Acceptance

- Migration adds the table cleanly; history survives restart.
- Jump-back replays from the trail without corrupting queue state — checked against the §5 rules, since this is a new way to change what plays next.
- The cap or eviction policy is stated in the card and covered by a test, not left implicit.
- Whether history belongs in **D11**'s export bundle is decided explicitly and recorded in the design doc. It is genuinely arguable both ways; what is not acceptable is deciding it by omission.

## Notes

Makes the deck a session view rather than a track inspector. The D11 question is the real content of this card — the pane itself is easy.
