---
taskId: 01KYTWR7KRXJZ4SD5GKW1J1AKA
title: Playlist-backed PlayOrder and the viewed/playing split
status: in-progress
priority: high
labels:
  - M4
  - renderer
  - playback
workstream: W5
workstreamId: W5-2
dependsOn:
  - 01KYTWQWYQK7NG2VNSA4MTGT2K
order: 1
created: '2026-07-31T01:31:21.079Z'
updated: '2026-07-31T01:57:06.613Z'
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

## Outcome

`PlayOrder` fit without amendment. `createPlaylistPlayOrder` is `at()`/`count()` over
`playlists.listEntries`, and shuffle and repeat took it unmodified — the shuffled order's id
reads `shuffle:<seed>:<pin>:playlist:7`, which is the composition made visible. Nothing in the
controller branches on which kind of order it holds; both entry points funnel through one
`startOrder`.

Three decisions a reader will want the reasons for:

- **`PlaylistEntry.id` stops at the play order.** It is the identity of a row everywhere else in
  the playlist contract, because D12 makes the same track legal twice. A traversal identifies
  rows by *position*, under which duplicates are not ambiguous, so adding an entry id to `at()`
  would put a playlist-shaped field on an interface the library order cannot fill. W5-5's queue
  holds track ids and is where entry identity would have to reappear if it ever must.
- **`crossfadeMs` is a required `playFromPlaylist` parameter, not a lookup.** Whatever offered
  the user the row is holding the `Playlist` record already, so this keeps the play path free of
  a round trip — the same reason `track` is passed. Required rather than optional so starting a
  playlist can never quietly fall back to the global setting.
  `playlistCrossfadeChanged(id, ms)` exists so an edit made *while* a playlist is playing still
  reaches the scheduler; without it the playlist value is the source of truth only until
  somebody touches it.
- **`viewedPlaylistId` lives in the new `stores/playlists.ts`, `playingPlaylistId` on the
  controller,** and the controller has no route to the former. The §5 guarantee is worth more as
  a structural fact than as a rule to remember. The one crossing is the other direction —
  `remove()` calls `playlistDeleted()` (rule 4) before the rows go.

Coverage note: the store itself is not unit-tested, because stores compile against `@renderer`
and the DOM and `vitest.config.ts` deliberately provides neither. The split is tested at the
controller instead, the way `sourcesWiring.test.ts` tests the Sources chain: browsing another
playlist through the same `fetchPlaylistEntries` dependency leaves order, position, engine loads
and prefetch state byte-identical.
