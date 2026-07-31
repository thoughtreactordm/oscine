---
taskId: 01KYTKWZTTFHF9X5BBXRNVZ8JD
title: Format and signal readout pane
status: todo
priority: medium
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-3
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 8
created: '2026-07-30T22:56:39.769Z'
updated: '2026-07-30T22:56:39.769Z'
---
## Scope

- Codec and container, bit depth, sample rate, bitrate with CBR/VBR, channel layout, duration.
- ReplayGain track and album values, and which mode is actually being applied right now.
- Whether **R1**'s `<audio>` streaming fallback took over for this track, and the decoded-size estimate against the configured budget.

## Acceptance

- Correct values for MP3, FLAC and OGG from the `probe:fixture` library, plus one high-resolution lossless file.
- The streaming-fallback state is visibly distinct — this is the one place a user can find out why a transition was hard.
- Nothing renders as "unknown" that `music-metadata` actually provides.
- No new IPC surface unless it starts in `src/shared/ipc.ts`; prefer riding the metadata the renderer already holds.

## Notes

Fermata's pitch is format-first and today nothing in the UI surfaces any of it. This is the cheapest card in the stream — almost pure UI over data already in hand — and the best demonstration of what the deck is for. Good first card after the shell.
