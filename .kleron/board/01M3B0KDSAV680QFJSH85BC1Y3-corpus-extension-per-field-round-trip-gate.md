---
taskId: 01M3B0KDSAV680QFJSH85BC1Y3
title: Corpus extension — per-field round-trip gate
status: todo
priority: medium
labels:
  - '1.1'
  - tag-writeback
  - gate
workstream: W16
workstreamId: W16-16
order: 8
created: '2026-09-25T00:49:16.073Z'
updated: '2026-09-25T00:49:16.073Z'
---
Design: `oscine-tag-writeback` → "Test corpus (W16-3)" and **Decision D** (a field enters the registry only when its check is green on all five codecs).

## Scope
- Extend `probe:writeback-corpus` / `probe:writeback-fixture` with one `written:<field>` check per registry field across `flac | mp3 | vorbis | opus | aac`: **set**, **clear**, and for `list` fields a **multi-value** case (two composers read back as two, in order).
- `written:album-artist` (W16-14) is additionally read back through `music-metadata`, since the scanner groups on `common.albumartist` — a frame taglib reads but music-metadata misses would re-shatter albums on rescan.
- `bool` (`isCompilation`) and `int` (`beatsPerMinute`, totals) checks assert type, not just string equality.
- Every existing `preserved:*` check stays green — in particular a flush that does not touch album artist must still leave it untouched.
- Output: a per-field × per-codec matrix in the report. Any red cell is a **triage card**, not a fix folded into the gate run (M-gate philosophy), and that field stays non-admitted in W16-15's registry.

## Acceptance
- Gate runs green on Linux and Windows from the same commit, or every red cell has a triage card and its field is marked non-admitted.
- Can proceed in parallel with W16-15; W16-17's flush of a field depends on that field's cell being green.
