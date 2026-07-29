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
