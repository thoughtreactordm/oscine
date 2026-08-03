---
taskId: 01KZ40HZE65905A4K5JDY3MSY7
title: The listen accumulator and the threshold rule
status: todo
priority: high
labels:
  - renderer
  - playback
  - D17
workstream: W10
workstreamId: W10-3
order: 45
created: '2026-08-03T14:31:00.294Z'
updated: '2026-08-03T14:31:00.294Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The listen event.

A renderer-side accumulator beside the playback controller — where the position already is — that answers two questions about the track currently playing: how much of it was *actually audible*, and has that crossed the listened threshold.

**The threshold is Last.fm's, adopted wholesale:** the track is longer than 30 seconds, **and** accumulated audible time has reached either half its duration or four minutes, whichever comes first. Do not re-derive it; twenty years of tuning against real listening is not worth relitigating, and adopting it verbatim is what keeps Fermata's numbers and the operator's Last.fm profile from disagreeing and then needing explaining.

**Accumulated audible time**, precisely:
- Paused time does not count.
- Seeked-over regions do not count. This is not just tidy bookkeeping — it is Last.fm's own rule that a track must not be scrobbled by scrubbing through it.
- A region played twice counts twice.
- A 40-minute track abandoned halfway records the twenty minutes that happened, not forty that did not.

The natural implementation is to accumulate on position deltas and reject any delta larger than a small epsilon as a seek rather than playback, rather than trying to observe seek events. Whatever the approach, it must be a **pure, testable unit** — no `AudioContext`, no timers — fed position and play/pause state by the controller. That is what makes the table-driven test below possible.

Its output surface: `msListened`, `crossedThreshold`, and `startedAt` (stamped at transport-commit, because that is the timestamp Last.fm wants and it is also the truth).

**Tests** (`tests/renderer/playback/`), table-driven: a 25-second track never crosses; exactly-half on a 3-minute track; the four-minute cap reached on a 30-minute track before half; pause-and-resume; seek forward past the threshold point (must not cross); seek backward and replay a region (must count twice); repeat-one producing a fresh accumulator per pass.

**Done when:** the accumulator is unit-tested with no audio graph in the test, and the existing `tests/renderer/playback/controller.test.ts` still passes.
