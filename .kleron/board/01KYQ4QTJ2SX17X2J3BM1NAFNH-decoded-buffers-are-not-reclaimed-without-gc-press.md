---
taskId: 01KYQ4QTJ2SX17X2J3BM1NAFNH
title: >-
  Decoded buffers are not reclaimed without GC pressure — R1's budget must count
  uncollected garbage as live
status: backlog
priority: medium
labels:
  - R1
  - M2
  - from-W6-2
triageKind: bug
workstream: W3
workstreamId: W3-4
order: 2
created: '2026-07-29T14:33:58.593Z'
updated: '2026-07-29T15:00:08.213Z'
---
Found by the M1 exit gate (W6-2) on Linux, 2026-07-29.

## What was observed

**This is not a leak.** The engine drops its references correctly. But nothing
forces collection, so RSS behaves as though it were one.

After the 63-minute track settled at 1590 MiB, nine further short tracks were
played (~85 MiB decoded in total, longest 28 s). Renderer RSS over that sequence:

```
1590 1600 1610 1621 1632 1645 1656 1668 1680 1689 1690  (MiB)
```

Monotonic. Every decode added; none of the eleven previous buffers came back.

Four forced `HeapProfiler.collectGarbage` calls then dropped renderer RSS from
**1690 MiB to 200 MiB**, with a 28.9 MB JS heap. So all of it was collectable —
V8 simply saw no reason to collect. AudioBuffer backing stores live outside the
JS heap, so a 1.4 GiB buffer registers as ~nothing in the heap statistics V8
schedules collection against.

## Why it matters

R1 is specified to "enforce the total budget across current+prefetch". If the
budget is computed from what the engine believes it currently holds, it will
report ~10 MiB while the process is actually sitting on 1.4 GiB of dead
AudioBuffers. The budget is then meaningless: the guard admits new decodes
against headroom that does not exist, and the OOM arrives with the accounting
still showing green.

M1 has no prefetch yet — each `next()` produced exactly one decode line — so
there is currently only one term to sum. This becomes live the moment prefetch
lands.

## Suggested shape

Two options, not mutually exclusive:

1. **Budget against issued-not-proven-freed.** Track every buffer the engine has
   ever handed out and only subtract when it can prove release, rather than
   assuming a dropped reference is reclaimed memory.
2. **Force the collection.** Renderers can be launched with `--expose-gc` and the
   engine can hint after a track change. Ugly, and it couples the engine to a
   launch flag, but it makes the accounting true instead of merely careful.

Whichever way it goes, the R1 memory guard should be tested against RSS, not
against what the engine thinks it holds — the two diverged by 1.5 GiB here.

Worth re-measuring on Windows: V8's heuristics and the external-memory pressure
signal are not identical across platforms. See the Windows column still owed on
W6-2.

---

# Windows confirmation — W6-3, 2026-07-29

This card said it was "worth re-measuring on Windows: V8's heuristics and the
external-memory pressure signal are not identical across platforms". They have
been re-measured, at the same commit and from the same script. **They are
identical, to within 0.1%.**

## Forced collection, both platforms

Measured while a short fixture track is playing, so the large buffers from the
preceding hour-long decode are unambiguously garbage:

| | Linux | Windows |
|---|---|---|
| RSS before forced GC | 1594 MiB | 1557 MiB |
| RSS after forced GC | 198 MiB | 159 MiB |
| **recovered** | **1396 MiB** | **1398 MiB** |

Both runs return the same verdict: *collectable — not a leak, but nothing collects
it without pressure.* V8 declines to collect external AudioBuffer backing stores
to the same degree on both platforms, and forced collection recovers effectively
all of it on both. There is no platform-specific heuristic to accommodate.

## Corroboration from a second measurement

The gate produced independent evidence of the same effect without looking for it.
The longest-real-track step runs immediately after the hour-long synthetic decode,
and recorded its starting RSS as **1508 MiB (Linux) / 1466 MiB (Windows)** against
true idle baselines of 196 and 148 MiB. The previous track's dead 1.3 GiB buffer
was still resident, on both platforms, with the engine holding no reference to it.

That is this card's finding showing up as measurement error in a *different* card
— it understated W3-3's transient-peak ratio by about half. Which is the concrete
form of the risk described above: **an accounting scheme that trusts dropped
references reports headroom that does not exist**, and here it did so to a
measurement rather than to a user, only because M1 has no prefetch yet.

## Bearing on the two suggested options

Neither option is platform-gated, so the choice can be made on its merits:

- **Budget against issued-not-proven-freed** — portable as written.
- **Force the collection via `--expose-gc`** — the probe's forced
  `HeapProfiler.collectGarbage` works identically on both platforms, so the
  mechanism is known to be available and effective on each. Still ugly, still
  couples the engine to a launch flag.

The card's closing recommendation stands and is strengthened: **test the R1 guard
against RSS, not against what the engine believes it holds.** The two diverged by
~1.4 GiB on Linux and ~1.4 GiB on Windows.

**Unblocked.** Nothing further is owed from the Windows side.
