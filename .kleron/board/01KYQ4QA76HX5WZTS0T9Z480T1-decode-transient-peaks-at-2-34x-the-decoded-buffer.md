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

---

# Windows confirmation — W6-3, 2026-07-29

This card said the multiplier "should be measured on Windows too before it is
hardcoded". It has been, at the same commit and from the same script.
**It transfers. The constant can now be set.**

## Careful — two different ratios are in play on this card

They have different denominators and must not be mixed:

| name | definition | what it answers |
|---|---|---|
| the "2.34x" headline above | `peak / decoded` | how large is the peak, in units of the buffer |
| the probe's `peakGrowthOverDecoded` | `(peak - baseline) / decoded` | how much did the process *grow*, in units of the buffer |

The growth figure is the one a guard actually needs, because the baseline is
already resident when the decision is made.

## Windows vs Linux — synthetic hour-long FLAC

Identical fixture on both machines, byte-for-byte: 41.4 MiB encoded, 1318.4 MiB
decoded at the 48 kHz context rate, ratio 31.9x.

| | Linux | Windows |
|---|---|---|
| RSS baseline | 196 MiB | 148 MiB |
| RSS **peak during decode** | 2707 MiB | 2717 MiB |
| RSS settled | 1508 MiB | 1468 MiB |
| **`peakGrowthOverDecoded`** | **1.90** | **1.95** |
| time to first audio | 6226 ms | 6011 ms |

**A 2.6% spread across two operating systems, two audio stacks and two machines.**
WASAPI shared-mode resampling and PipeWire's cost the same here. The multiplier is
a property of the decode path, not of the platform, and is safe to hardcode.

## Use the synthetic figure, not the real-track one

The longest-real-track measurement (Dopesmoker, the same 373.7 MiB FLAC on both
machines) reports **1.19 on Linux and 1.23 on Windows** — and both are wrong,
understated in the same way and for the same reason.

That step runs *after* the synthetic decode, so its "baseline" is not idle: 1508
MiB on Linux and 1466 MiB on Windows, against true idle baselines of 196 and 148.
The previous track's dead buffer is still resident and counted as baseline, so the
growth term is measured from an inflated floor and comes out roughly half of what
it should be.

That contamination is W3-4 — decoded buffers are not reclaimed without GC
pressure — corrupting this card's measurement. Worth knowing generally: **any RSS
growth figure taken after a prior decode is understated until something forces a
collection.** The synthetic step is the only one on either platform that runs from
a clean-ish baseline, which is what makes 1.90 / 1.95 the trustworthy pair.

## Recommended constant

Per-track admission on `estimatedDecodedBytes x 2 + encodedBytes`, with the 2x now
measured at 1.90–1.95 on both platforms and rounded up for headroom. `encodedBytes`
is `tracks.size` and is known before the decode starts, as the card notes.

The decode-latency argument also survives the crossing: **6.0–6.2 s to first audio
for a one-hour track on both platforms**, and 7.8 s (Linux) / 8.9 s (Windows) for
the 63-minute real one. A streaming fallback that triggers well below the memory
cap remains justified on latency alone.

**Unblocked.** Nothing further is owed from the Windows side.
