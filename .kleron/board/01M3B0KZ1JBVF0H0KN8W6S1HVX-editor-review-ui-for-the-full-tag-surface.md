---
taskId: 01M3B0KZ1JBVF0H0KN8W6S1HVX
title: Editor + review UI for the full tag surface
status: todo
priority: medium
labels:
  - '1.1'
  - tag-writeback
  - ui
workstream: W16
workstreamId: W16-18
dependsOn:
  - 01M3B0KQ3QB4D2KKZR6VK41EJA
order: 10
created: '2026-09-25T00:49:33.745Z'
updated: '2026-09-25T00:49:33.745Z'
---
Design: `oscine-tag-writeback` → "The full tag surface" (registry table, Decisions F–H).

## Scope
- `TrackMetadataEditor.vue`: the grouped fields stay on top as today; below them an **"All fields"** area generated from the registry, one collapsible section per group (Credits, Numbering, Release, Content, Sorting, Advanced, Read-only). Collapsed by default; opening it triggers W16-17's lazy file read.
- Inputs by `kind`: text, int, bool (compilation toggle — Decision H, no grouping side effect), **list** (chip-style add/remove/reorder for composers and the sort lists). Lyrics and comment get a multi-line input.
- Batch semantics match the existing fields: "multiple values" placeholder for `mixed`, untouched fields stay out of the patch, per-field overridden marker and revert.
- Read-only group (ReplayGain) displays, never edits (Decision F). Advanced (MusicBrainz ids) is editable.
- Review UI (W16-6): generic fields appear as ordinary old → new rows with per-field select/deselect; list values render readably; the virtualization invariant holds with many more rows per track.
- Theming through the token layer only; no hardcoded colour. Panel stays an island.
- Adding a registry entry must require **zero** component changes — the acceptance check for the registry being real.

## Acceptance
- Edit composers on a 20-track batch, flush, rescan → values persist; mixed batch shows placeholder; revert works per field.
- A throwaway registry entry added in a test renders in the editor and review with no component edit.
- Verified in the user's own `npm run dev` (no web preview for Electron).
