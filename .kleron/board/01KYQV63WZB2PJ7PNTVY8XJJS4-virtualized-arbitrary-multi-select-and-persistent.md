---
taskId: 01KYQV63WZB2PJ7PNTVY8XJJS4
title: Virtualized arbitrary multi-select and persistent configurable columns
status: done
priority: high
labels:
  - M3
  - UI
  - multi-select
  - columns
  - virtualized
workstream: W4
workstreamId: W4-4
dependsOn:
  - 01KYQV5FCHTQ9JTDFBAMXHA75X
effort: high
order: 5
created: '2026-07-29T21:06:15.582Z'
updated: '2026-07-30T13:48:41.168Z'
---
Finish the power-user interaction surface deferred by W4-1: arbitrary selection across a virtualized result and a column layout the user controls. The selection contract must be ready for M4's add-to-playlist action, but this card does not build playlists.

## Scope

- Single click replaces selection; Ctrl+click toggles individual tracks; Shift+click selects the inclusive range from a stable anchor; Ctrl+Shift extends without destroying disjoint selections.
- Make selection track-id based across loaded pages, sorting and temporary filtering. Rows that disappear under a filter remain selected and reappear selected when the filter is removed.
- Resolve Shift ranges that cross unloaded pages without mounting or retaining those rows. Use a bounded/chunked id query or compact selection model rather than loading full `Track` objects.
- Define a renderer-facing selection API that exposes count and stable track ids (or a documented resolvable descriptor) for M4, with deterministic ordering when consumed.
- Keep keyboard navigation separate from selection focus; add Space/Ctrl+Space and Shift+arrow range operations with visible focus and anchor states.
- Add a column chooser for visibility and order, plus pointer/keyboard column reordering and width adjustment. Persist the configuration across app restarts and provide a Reset to defaults action.
- Sorting remains available only on supported fields and must survive a column being hidden/re-shown.
- Keep virtualization's page cache bounded regardless of selection size.

## Explicitly not in scope

Playlist creation/add actions, drag-and-drop to playlists, cell editing, grouped rows, per-playlist column layouts, or exporting UI preferences.

## Acceptance

- Ctrl selection creates and edits disjoint sets; Shift ranges work across at least 10,000 unloaded rows and in both sort directions.
- A selection survives sort and search/filter round-trips by track id without retaining 10,000 `Track` objects or growing the DOM.
- Keyboard and pointer operations agree on focus, anchor, count and selected rows.
- Column visibility/order/width survives a full restart; Reset restores the documented default set.
- Hiding the active sort column does not corrupt ordering or leave an inaccessible sort state.
- The M4 consumer can obtain the selected tracks in deterministic list order without scraping rendered rows.
- The 100k fixture preserves flat DOM and frame-budget interaction while large selections exist.
