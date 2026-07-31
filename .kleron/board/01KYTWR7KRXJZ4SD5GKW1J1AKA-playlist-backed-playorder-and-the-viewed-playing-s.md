---
taskId: 01KYTWR7KRXJZ4SD5GKW1J1AKA
title: Playlist-backed PlayOrder and the viewed/playing split
status: todo
priority: high
labels:
  - M4
  - renderer
  - playback
workstream: W5
workstreamId: W5-2
dependsOn:
  - 01KYTWQWYQK7NG2VNSA4MTGT2K
order: 21
created: '2026-07-31T01:31:21.079Z'
updated: '2026-07-31T01:31:21.079Z'
---
## Scope

- `createPlaylistPlayOrder` beside `createListPlayOrder`, paging entries by position. Shuffle
  and repeat already compose with anything satisfying `PlayOrder`, so a playlist gets both for
  free — do not reimplement either.
- `playFromPlaylist(playlistId, index)` on the controller alongside `playFromList`.
- `viewedPlaylistId` and `playingPlaylistId` become **separate** state, per the §5 preamble.
  Browsing another tab must not disturb playback in any way.
- Deleting the playing playlist stops playback (the second half of rule 4).
- The playing playlist's `crossfade_ms` is what the scheduler reads for a boundary, replacing
  the global setting as the source of truth once a playlist is playing.

## Acceptance

- Switching the viewed tab mid-playback changes nothing observable about the audio graph — no
  re-decode, no prefetch churn, no `orderIndex` movement. Tested.
- Shuffle over a playing playlist permutes that playlist's entries only, and the unshuffled
  base order survives alongside it exactly as it does for the library order today.
- Repeat-all wraps at the playlist's end rather than the library's.
- Deleting the playing playlist stops playback, with a test.
- Tests in `tests/renderer/playback/`.

## Notes

**D5**. `PlayOrder` was written as a snapshot with `at()`/`count()` precisely so a second
implementation could arrive later; this is that implementation and the card that proves the
abstraction earned its place. If it does not fit, that is a finding worth writing down, not a
reason to special-case playlists inside the controller.
