---
taskId: 01KYQ4QA76HX5WZTS0T9Z480T1
title: >-
  Decode transient peaks at 2.34x the decoded buffer — the R1 guard must budget
  for it
status: backlog
priority: high
labels:
  - R1
  - M2
  - from-W6-2
triageKind: bug
workstream: W3
workstreamId: W3-3
order: 1
created: '2026-07-29T14:33:41.862Z'
updated: '2026-07-29T15:00:06.475Z'
---
Found by the M1 exit gate (W6-2) on Linux, 2026-07-29. Dev build, so absolute
figures are inflated; the **ratio** is the finding.

## Measurement

Sleep — Dopesmoker, FLAC, 3809.03 s (63.5 min), 44.1 kHz stereo, 373.7 MiB
encoded. Renderer RSS sampled at 4 Hz across the decode.

| point | renderer RSS |
|---|---|
| idle baseline | 276 MiB |
| **peak, during decode** | **3190 MiB** |
| settled, during playback | 1590 MiB |

Decoded buffer: 1,462,666,368 B = 1.362 GiB.

- Peak is **2.34x the decoded buffer**.
- Peak is **1.60 GiB above** the settled figure.
- Settled minus baseline (1314 MiB) matches the decoded buffer, so the steady
  state is honest — it is the transient that is not.

The overshoot is the decode holding the encoded ArrayBuffer (373.7 MiB) and the
resampler's intermediate alongside the output AudioBuffer, none of which the
final size accounts for.

Time from `playFromList` to `status === 'playing'` was **9770 ms**, and the
promise did not resolve before then.

## Why it matters

R1's guard is specified as "estimate decoded size before decoding; fall back to
`<audio>` streaming above the per-track cap; enforce the total budget across
current+prefetch". Every clause of that thresholds on the **final** decoded size.
A cap set at, say, 1.5 GiB admits this track and then transiently allocates
3.1 GiB. On a machine with less headroom that is the crash the guard exists to
prevent.

A 2-hour DJ mix — well within what a real library holds — would decode to ~2.8 GiB
and peak near 6 GiB.

## Suggested shape

The per-track cap should be applied to `estimatedDecodedBytes + encodedBytes + a
resampler allowance`, not to the decoded size alone. `encodedBytes` is already
known before the decode starts (it is `tracks.size`). The multiplier should be
measured on Windows too before it is hardcoded — see the Windows column still
owed on W6-2.

Note also that the 9.8 s blocking decode is itself an argument for the streaming
fallback kicking in well below the memory cap: a track that takes ten seconds to
become audible is a UX failure before it is a memory failure.
