---
taskId: 01KYTWQWYQK7NG2VNSA4MTGT2K
title: 'Playlist store: CRUD, fractional positions, IPC contract'
status: done
priority: high
labels:
  - M4
  - main
  - db
workstream: W5
workstreamId: W5-1
order: 5
created: '2026-07-31T01:31:10.166Z'
updated: '2026-07-31T19:17:34.326Z'
---
## Scope

- Schema v1 already ships `playlists` and `playlist_entries`, the REAL `position` column and
  both indexes. There is nothing to migrate. This card is the module that finally uses them:
  `src/main/library/playlists/`.
- Tab CRUD: create, rename, delete, reorder (`playlists.position`, integer tab order).
- Entry operations: append, insert between two neighbours at a fractional position, remove,
  move. Never renumber a whole list to accommodate one insert — that is what the REAL is for.
- Reads are paged and ordered by position, the same query shape as the library list, because
  the contents pane (W5-5) is virtualized from its first commit.
- Duplicates are legal per **D12**: the same `track_id` may appear twice in one playlist.
  `playlist_entries.id` is the identity everywhere, never `track_id`.
- Typed surface lands in `src/shared/ipc.ts` first, then the handler — new IPC never starts in
  a handler.

## Acceptance

- Inserting between two adjacent entries writes exactly one row and leaves every other
  `position` byte-identical, asserted by a test.
- A rebalance path exists for when repeated between-inserts exhaust float precision, with a
  test that actually drives positions to that point rather than asserting the function exists.
- Deleting a playlist cascades its entries; deleting a track cascades its entries. Assert
  `foreign_keys` is genuinely on rather than trusting the DDL.
- Batch add: enqueueing a multi-select of thousands of tracks is one call, not one per track.
- Tests in `tests/main/library/`.

## Notes

**D12**. `crossfade_ms` lives on `playlists` as R2's per-boundary policy carrier — persist and
return it here, but do not wire the audio engine to it; W3 consumes it. Playlists reference
track ids only, so the relative-path invariant is untouched by this card.
