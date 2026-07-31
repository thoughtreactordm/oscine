---
taskId: 01KYTWRE2E1YTC09T38F48NH3S
title: Playlist tab bar
status: todo
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-3
dependsOn:
  - 01KYTWQWYQK7NG2VNSA4MTGT2K
order: 22
created: '2026-07-31T01:31:27.693Z'
updated: '2026-07-31T01:31:27.693Z'
---
## Scope

- **D5**'s backbone made visible: the named tab strip, replacing the static shelves the Curate
  view currently scaffolds.
- Create, rename inline, delete, and drag to reorder tabs.
- The viewed tab and the playing tab are indicated **differently**, because §5 makes them
  different things and the operator has to be able to see which is which at a glance.
- Keyboard: switch tabs, rename, close.

## Acceptance

- Reordering persists to `playlists.position` and survives a restart.
- The playing tab stays marked while a different tab is viewed — this is the visible proof of
  the viewed/playing split.
- Deleting a non-empty tab confirms first; deleting the playing tab warns that playback stops.
- Colours come from the token layer, never hardcoded.
- Renderer tests in `tests/renderer/`.

## Notes

**D4** island rules apply: the tab strip assumes nothing about the pane beneath it, so the
contents pane can be swapped or docked elsewhere without touching this component.
