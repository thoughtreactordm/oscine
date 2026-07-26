---
taskId: 01KYECGYZEYQ1N1DDKBY5RYD1S
title: Virtualized sortable track list panel
status: todo
priority: high
labels:
  - M1
workstream: W4
workstreamId: W4-1
dependsOn:
  - 01KYECFMPA141ZPJM8F2X54BAS
effort: high
order: 6
created: '2026-07-26T04:56:52.461Z'
updated: '2026-07-26T04:56:52.461Z'
---
The first panel island (design section 7). One flat track list — the three-pane Artist/Album/Song browse arrives at M3.

## Scope

- `TrackList` as a self-contained island under `src/renderer/panels`, making no assumptions about neighbouring panels. This is D4's whole point and the reason a docking system can land later without a rewrite.
- **Virtualized from the first commit.** The design targets 100k tracks; rendering all rows and retrofitting virtualization later means rewriting selection, scroll restoration and keyboard navigation.
- Columns: track number, title, artist, album, duration. Click-to-sort ascending/descending with a visible indicator.
- **Sort in SQL, not in the renderer.** Sorting 100k rows client-side means shipping 100k rows across IPC. Sort and paginate in the query; the panel requests windows of rows.
- Row selection with single click, and keyboard navigation with arrows plus Home/End.
- A Pinia store for panel state: sort column, direction, selection.
- Build against CSS custom-property tokens rather than hardcoded colors — D9 makes theming structural, and this panel sets the pattern every later panel copies.

## Explicitly not in scope

Shift/ctrl multi-select (M3, alongside add-to-playlist), configurable column sets (M3), grouping.

## Acceptance

- A synthetic 100k-row dataset scrolls smoothly with a flat DOM node count.
- Sorting a 100k-row library returns without perceptible delay, confirming the work happens in SQLite.
- No hardcoded color values anywhere in the component.
