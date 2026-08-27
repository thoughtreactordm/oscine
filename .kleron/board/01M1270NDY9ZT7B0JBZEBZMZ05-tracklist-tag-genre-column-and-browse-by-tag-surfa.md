---
taskId: 01M1270NDY9ZT7B0JBZEBZMZ05
title: TrackList tag/genre column and browse-by-tag surface
status: todo
priority: low
labels: []
workstream: W15
workstreamId: W15-5
workstreamDependsOn:
  - W4
dependsOn:
  - 01M126ZBGXQZ8QTJ9W6E5N2CBS
order: 4
created: '2026-08-27T18:16:47.805Z'
updated: '2026-08-27T19:12:24.951Z'
---
Make tags visible and browsable in the main library, closing two gaps: genre is not shown in `TrackList`/`ColumnChooser` today, and there is no way to browse by it.

## Column

- Add an optional **Genre/Tags** column to `TrackList`, registered through `ColumnChooser` like the other configurable columns. Shows file genres + user tags unified (origin distinguishable on hover/among chips, but one column).
- Column width/visibility is `view`-scoped session state per W8 (localStorage-backed, no IPC per drag) — follow the existing column persistence, do not hand-roll a new store.

## Browse / filter

- A browse-by-tag surface (a facet/filter that narrows the TrackList to a chosen tag or genre). Reuse `tags.list` for the vocabulary.
- **Virtualized from the first commit** (100k-track scale target) — this is an invariant, not a later retrofit.

## Notes

- Keep it a projection: this card only reads user tags + file genres; it does not create the write path (earlier cards own that).
- Coordinate the column's exact identity/label with the Tags pane so the two surfaces name the concept the same way.
