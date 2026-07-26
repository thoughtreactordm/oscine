---
taskId: 01KYECHS6GHY3ZHSFHZMTS2VHR
title: Transport controls and wiring the list to the engine
status: todo
priority: high
labels:
  - M1
workstream: W4
workstreamId: W4-2
dependsOn:
  - 01KYECHBRGWEZFS13A6DX4HTJJ
  - 01KYECGYZEYQ1N1DDKBY5RYD1S
  - 01KYECGN8JRHFBMDEBTRS9ZT1E
effort: medium
order: 8
created: '2026-07-26T04:57:19.311Z'
updated: '2026-07-26T04:57:19.311Z'
---
The card that closes the M1 loop: a real folder becomes a browsable list becomes audible sound.

## Scope

- A `NowPlaying` panel island: current track title, artist, album, elapsed and total time.
- Transport: play/pause, next, previous, a draggable seek bar, and a volume control.
- Double-click a row in `TrackList` to play it.
- Next/previous traverse the **current sort order of the list**, not database insertion order. This is the first appearance of "play order", and getting it wrong here bakes a wrong assumption into W5.
- A Pinia playback store bridging the `AudioEngine` and the UI. The store holds observable playback state; the engine stays the single source of truth for time and duration.
- Seek bar updates driven by the engine's time-update events, and dragging must not fight the updates — suspend follow while the user holds the handle.

## Explicitly not in scope

No playlists, no queue, no shuffle, no repeat — all W5 at M4. "Next track" here means the next row in the list, nothing more.

## Acceptance

- Add a folder, browse it, double-click a track, hear it, seek within it, adjust volume, skip to the next.
- Playback state stays correct through rapid skipping — no orphaned audio from a previous track continuing underneath.
- Reaching the end of the last row stops cleanly rather than erroring.
