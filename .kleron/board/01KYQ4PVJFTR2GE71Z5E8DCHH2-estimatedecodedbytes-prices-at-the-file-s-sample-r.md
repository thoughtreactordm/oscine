---
taskId: 01KYQ4PVJFTR2GE71Z5E8DCHH2
title: 'estimateDecodedBytes prices at the file''s sample rate, not the AudioContext''s'
status: backlog
priority: high
labels:
  - R1
  - M2
  - from-W6-2
triageKind: bug
workstream: W3
workstreamId: W3-2
order: 0
created: '2026-07-29T14:33:26.863Z'
updated: '2026-07-29T15:00:04.476Z'
---
Found by the M1 exit gate (W6-2) on Linux, 2026-07-29.

## What was observed

Playing a 44.1 kHz FLAC logged:

```
[audio] R1 track=2424 encoded=373.7MiB decoded=1.4GiB ratio=3.7x
        duration=3809.0s rate=48000Hz channels=2
```

`rate=48000Hz` for a 44,100 Hz file. `decodeAudioData` resamples to the
AudioContext's rate, which is the **output device's** rate, so the decoded buffer
is `duration x contextRate x channels x 4` — not `duration x fileRate x ...`.

## Why it matters

`estimateDecodedBytes(durationSec, sampleRateHz, channels)` in
`src/renderer/audio/decodedSize.ts` is documented as "the M2 guard's input", and
callers feed it `sample_rate` straight from the `tracks` row. That is the file's
rate. So the guard would misprice any track whose file rate differs from the
device rate:

- 44.1 kHz file on a 48 kHz device: **under** by 8.8%. 2514 tracks in the test
  library.
- 96 kHz file on a 48 kHz device: **over** by 2x. 244 tracks in the test library.
- 192 kHz file on a 48 kHz device: **over** by 4x. 6 tracks.

Underpricing is the dangerous direction — the guard lets a track through and then
pays more than it budgeted. Overpricing pushes hi-res tracks onto the streaming
fallback that did not need to go there.

The device rate is not knowable from the database. It comes from
`AudioContext.sampleRate` at runtime, and it can differ between the two platforms
on the same library.

## Suggested shape

`estimateDecodedBytes` takes the target rate as an explicit argument rather than
reading the file's rate as if it were the decode rate. The file's rate stops
being an input to the size calculation entirely — it only ever mattered as a
proxy. Keep the function free of Web Audio types as it is now; the caller passes
`ctx.sampleRate`.

Worth a test that pins the 44.1 -> 48 case, since it is the common one and the
error is small enough to hide.
