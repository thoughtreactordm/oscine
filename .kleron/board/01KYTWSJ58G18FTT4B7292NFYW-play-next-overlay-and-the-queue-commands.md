---
taskId: 01KYTWSJ58G18FTT4B7292NFYW
title: Play-next overlay and the queue commands
status: todo
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-7
dependsOn:
  - 01KYTWS0VXNMWQFQE9PC4X31CR
order: 26
created: '2026-07-31T01:32:04.646Z'
updated: '2026-07-31T01:32:04.646Z'
---
## Scope

- The queue commands, in one shared module: **Play next** and **Add to queue**, available from
  the library list, the playlist contents pane, and any multi-select in either.
- The overlay named in M4's scope: a compact popover over the transport listing what is queued,
  with remove, clear, and jump-to-entry. A queued-count indicator on the transport so a
  non-empty queue is never invisible.
- Reordering inside the overlay is optional here — the full editor is **W7-2** in M5.

## Acceptance

- The commands live in a module the Tunedeck up-next pane can import unchanged. W7-2 replaces
  this overlay's body with the deck pane; it must not have to reimplement the verbs.
- Queueing from a multi-select preserves the selection's visible order.
- The overlay is virtualized if it can show more than a screenful — the standing invariant has
  no exception for popovers.
- Every colour through the token layer.
- Renderer tests in `tests/renderer/`.

## Notes

**D5**, and the M4 scope line "play-next overlay". Deliberately the smaller surface: M5's
Tunedeck (**D15**) owns the real editor, and building it twice is the failure mode this card
exists to avoid.
