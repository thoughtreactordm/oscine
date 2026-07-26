---
taskId: 01KYECHBRGWEZFS13A6DX4HTJJ
title: AudioEngine interface and decodeAudioData playback
status: todo
priority: high
labels:
  - M1
  - R1
workstream: W3
workstreamId: W3-1
dependsOn:
  - 01KYECFMPA141ZPJM8F2X54BAS
effort: high
order: 7
created: '2026-07-26T04:57:05.551Z'
updated: '2026-07-26T04:57:05.551Z'
---
Make sound come out, behind an interface that can survive being replaced.

The interface is the point of this card. D2 accepted a pipeline with a known memory ceiling (**R1**), on the explicit condition that the implementation sits behind a boundary the UI never sees through. If R1 forces a WebCodecs rewrite at M2 or later, only the implementation changes.

## Scope

- Define `AudioEngine` in `src/renderer/audio` — an interface first, implementation second. Surface roughly: `load(trackId)`, `play()`, `pause()`, `seek(seconds)`, `setVolume(gain)`, `currentTime`, `duration`, plus events for ended, time-update and error.
- **Nothing in the interface may mention `AudioBuffer`, `decodeAudioData` or any Web Audio type.** If a Web Audio concept appears in the signature, the abstraction has already failed and the M2 swap will not be clean.
- `DecodedAudioEngine` implementing it: fetch bytes via the mechanism chosen in the IPC card, `decodeAudioData`, play through `AudioBufferSourceNode` → `GainNode` → destination.
- Volume via the gain node, not by scaling samples. M2 hangs ReplayGain and crossfade off this same node.
- Correct handling of the fact that `AudioBufferSourceNode` is single-use: a fresh node per play and per seek, with `currentTime` tracked against the AudioContext clock rather than assumed.
- Resume the AudioContext on first user gesture — Chromium autoplay policy applies inside Electron.

## Explicitly not in scope

No prefetch, no gapless, no crossfade, no ReplayGain. All M2. One track at a time, hard stop between tracks.

## Note on R1

M1 has no memory guard, so a very long track may allocate hundreds of megabytes here. That is accepted for M1 and is precisely the risk M2 exists to measure. **Log the decoded byte size on every load** — those numbers are the input to M2's threshold decision, and having real figures beats guessing.

## Acceptance

- MP3, FLAC and OGG all play, seek and report accurate duration.
- Volume changes are click-free.
- Playing a second track cleanly tears down the first with no leaked nodes.
- A reviewer can describe how a WebCodecs implementation would slot in without touching UI code.
