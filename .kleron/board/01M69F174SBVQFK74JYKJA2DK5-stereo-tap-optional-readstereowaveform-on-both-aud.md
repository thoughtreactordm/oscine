---
taskId: 01M69F174SBVQFK74JYKJA2DK5
title: Stereo tap — optional readStereoWaveform on both audio paths
status: todo
priority: low
labels:
  - D35.10
  - audio
  - renderer
  - engine-contract
workstream: W23
workstreamId: W23-13
order: 12
created: '2026-10-31T17:10:04.696Z'
updated: '2026-10-31T17:37:35.138Z'
---
Spec: wiki `oscine-visualizers` → D35.10. Read the `AudioEngine.ts` file header first: this card changes the engine contract.

`readWaveform` is mono (`AnalyserNode` mixes its input down). An X/Y scope needs left and right separately, so this is the stream's only audio-layer change, isolated so that nothing else depends on it.

- **An optional method** beside `readWaveform` on `AudioEngine`, `AudioPath` and `GuardedAudioEngine`: `readStereoWaveform?(left: WaveformBuffer, right: WaveformBuffer): boolean`, exposed through the playback controller like `readWaveform` (`controller.ts:1782`).
  - The same tap point: after normalization and the transition fade, before master volume.
  - The same "false means nothing audible, buffers untouched" rule.
  - The same admission-path selection in `GuardedAudioEngine` (whichever path won, never a sum through a crossfade).
  - A mono source is copied to both channels.
  - Optional, so that an engine without it degrades (`needs.stereo` effects become unavailable) instead of failing to typecheck.
- **Lazy attach:** each path builds a `ChannelSplitter` and two analysers only while a stereo consumer is subscribed, and removes them when the last one goes. This follows `EqualizerRouter.subscribeClip`'s attach/detach precedent. Analysers stay leaves; nothing new reaches the destination.
- **Both paths in this card:** `DecodedAudioEngine` (tap at `transitionGain`) *and* `browserStreamingPlatform` (tap at `normalizationGain`). A scope that is silently flat on R1-streamed tracks is a bug nobody can reproduce; W19 recorded the same rule.

**Tests** (fake audio nodes, the `EqAudioNode` pattern):
- attach on the first subscription and detach on the last, on both paths;
- no analysers exist with zero subscribers;
- a mono source fills both buffers identically;
- `false` leaves both buffers untouched;
- `GuardedAudioEngine` reads only the admitted path.

**Done when:** both paths pass the above, the existing `readWaveform` behaviour and tests are unchanged, and the ribbon and visualizers still run with no stereo consumer and no extra nodes in the graph.
