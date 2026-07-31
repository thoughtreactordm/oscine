---
taskId: 01KYTKWQXSGY1WM6S56T16ZK3D
title: Up-next queue pane
status: todo
priority: high
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-2
workstreamDependsOn:
  - W5
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
  - 01KYTWS0VXNMWQFQE9PC4X31CR
  - 01KYTWSJ58G18FTT4B7292NFYW
order: 7
created: '2026-07-30T22:56:31.672Z'
updated: '2026-07-31T01:32:26.822Z'
---
## Scope

- The first visible surface for **D5**'s transient up-next queue, which today has none anywhere in the app.
- Drag to reorder, remove an entry, clear the queue, jump to an entry.
- Visually distinguishes queued entries from the playing playlist's natural upcoming order — they are different things and §5 treats them differently.
- Virtualized from the first commit.

## Acceptance

- All seven §5 queue rules are observable through this pane, not merely implemented beneath it.
- Reorder writes fractional positions rather than renumbering.
- Removing the currently-playing entry behaves exactly as §5 specifies, with a test.
- Virtualized list, per the standing invariant — no version of this pane renders the full queue.
- Renderer tests in `tests/renderer/`.

## Notes

**D5** and the seven rules in §5. Blocked on W5's queue model existing. This is the pane that justifies the drawer's existence — if only one phase-1 pane ships, it is this one.
