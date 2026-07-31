---
taskId: 01KYTWS86PVQZ4PVRNCZZFNE4V
title: Playlist contents pane
status: todo
priority: high
labels:
  - M4
  - ui
workstream: W5
workstreamId: W5-6
dependsOn:
  - 01KYTWRE2E1YTC09T38F48NH3S
  - 01KYTWR7KRXJZ4SD5GKW1J1AKA
order: 25
created: '2026-07-31T01:31:54.453Z'
updated: '2026-07-31T01:31:54.453Z'
---
## Scope

- The pane under the tab strip: the playlist's entries, reusing the existing virtualized
  TrackList island rather than growing a second list implementation.
- Drag to reorder, writing a fractional position for the moved row only.
- Add from the library: multi-select drag and a context-menu action, both batched into one
  call.
- Remove entries, including removing the currently-playing one.
- Duplicates render as distinct rows. Keys are `playlist_entries.id`, never `track_id`, or two
  copies of a track collapse into one row and reordering scrambles.

## Acceptance

- Virtualized from the first commit, per the standing invariant — no version of this pane
  renders every entry.
- Dropping a 5k-track multi-select is a single batched IPC call, not 5k round trips.
- A reorder writes one row; verified against the store test from W5-1 rather than assumed.
- Removing the playing entry behaves as §5 specifies, with a test.
- Sort columns are display-only here: position is the truth, and sorting the view never
  rewrites it.
- Renderer tests in `tests/renderer/panels/`.

## Notes

**D12**. The same track legitimately appearing twice is the detail that breaks naive
implementations of every operation on this pane.
