---
taskId: 01KYQ4PVJFTR2GE71Z5E8DCHH2
title: 'estimateDecodedBytes prices at the file''s sample rate, not the AudioContext''s'
status: in-review
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
updated: '2026-07-29T15:41:08.969Z'
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

---

# Windows confirmation — W6-3, 2026-07-29

The Windows column of the M1 exit gate is in, at the same commit and from the same
script. This card said the Linux number should not be hardcoded until Windows
confirmed it. **It is confirmed — but the conclusion is the opposite of a
hardcode.**

## What Windows measured

`audioContextSampleRateHz: 48000`. The same as Linux.

So the error has the **same sign on both platforms**, not the opposite one W6-3
flagged as possible: 44.1 kHz files underpriced by 8.8%, 96 kHz overpriced by 2x,
192 kHz by 4x, exactly as described above.

## Why this still does not license a constant

Both machines happened to land on 48 kHz. That is a coincidence of two default
output devices, not a property of either OS — WASAPI shared mode and PipeWire both
take the rate from device configuration, and a user with a 44.1 kHz DAC gets 44.1
kHz on either platform. Two samples of the same value are not evidence that the
value is fixed.

The suggested shape above is unchanged and now has cross-platform evidence behind
it: **take the target rate as an explicit argument, read from `ctx.sampleRate` at
the call site.** The file's rate never becomes an input to the size calculation.

## The bug reproduced in miniature, on Windows

`scripts/make-probe-fixture.mjs` prices its own synthetic hour-long FLAC the way
`estimateDecodedBytes` does — from the file's rate — and printed:

```
probe-long.flac   43362659 bytes  decodes to ~1.18GiB at 44.1kHz
```

The engine then actually allocated **1318.4 MiB** (1.288 GiB), because
`decodeAudioData` resampled 44.1 → 48 kHz:

```
[audio] R1 track=102993 encoded=41.4MiB decoded=1.3GiB ratio=31.9x
        duration=3600.0s rate=48000Hz channels=2
```

1318.4 / 1208.3 = **1.091** — the file-rate estimate is 8.4% short of the real
allocation, which is `48000 / 44100` to the decimal. A guard fed the fixture
generator's number would have admitted a track that costs 110 MiB more than
budgeted, on a single track.

That is this card's bug, reproduced on Windows, on a file whose true decoded size
is known in advance. It is also a ready-made test case for the 44.1 → 48 pin the
card asks for.

**Unblocked.** Nothing further is owed from the Windows side.
