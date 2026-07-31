---
taskId: 01KYTWRE2E1YTC09T38F48NH3S
title: Playlist tab bar
status: in-review
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-3
dependsOn:
  - 01KYTWQWYQK7NG2VNSA4MTGT2K
order: 2
created: '2026-07-31T01:31:27.693Z'
updated: '2026-07-31T12:20:43.216Z'
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

## Correction — superseded in part by W5-9

This card read "playlist tabs as the backbone" as "the tab strip *is* the list of playlists"
and drew `playlists.list` directly. The consequence went unwritten: with every playlist
rendered as a tab there is no closed state, so `×` had to call `remove` — a control labelled
`Close ${name}` that deleted the playlist.

W5-9 adds the rail and the strip becomes the *open* playlists. What survives from here
unchanged: the two indicators drawn differently, the keyboard map, the reorder arithmetic
(moved to `panels/playlistReorder.ts`, now shared), the inline rename (moved to
`panels/playlistRename.ts`, now shared), and the delete prompt with its rule-4 warning
(moved to `panels/playlistRail.ts`, where the row is the playlist).

The acceptance criteria above still hold — reordering still persists to `playlists.position`,
it is now the rail's drag that writes it.
