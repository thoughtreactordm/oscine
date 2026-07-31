---
taskId: 01KYTKWGS08GKKM5P6HR53HFMK
title: Tunedeck shell — drawer host and panel island
status: todo
priority: high
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-1
order: 6
created: '2026-07-30T22:56:24.351Z'
updated: '2026-07-30T22:56:24.351Z'
---
## Scope

- New panel island `src/renderer/panels/Tunedeck.vue`, opened from the placeholder button already sitting in `NowPlaying.vue:255`.
- Hosted in a `UDrawer` on the right: full height, resizable by drag, **pushes** the app content rather than covering it.
- Open/closed state and width in a Pinia store, persisted across restarts.
- A pane registry, so panes are independent components the shell merely arranges. Adding a pane must not require editing the shell.
- This card ships the shell plus one trivial pane, to prove the seam. No real panes.

## Acceptance

- The NowPlaying button opens and closes the deck; open state and width survive a reload.
- The track list stays scrollable and interactive with the deck open at any width — content is displaced, not occluded.
- Deck content imports nothing from `NowPlaying` or `TrackList`, and vice versa. Reviewed against **D4** and **D15**.
- Drag-resize is clamped to a stated min/max and holds frame budget while dragging.
- Zero colour literals anywhere in the new components — everything through the token layer.

## Notes

**D15**. The `UDrawer` is the host, not the feature. The pane arrangement must survive being reparented into a dock pane when the docking system lands, which is the whole reason the content is an island rather than drawer-shaped markup.
