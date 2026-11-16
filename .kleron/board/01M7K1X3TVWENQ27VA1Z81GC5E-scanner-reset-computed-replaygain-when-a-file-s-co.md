---
taskId: 01M7K1X3TVWENQ27VA1Z81GC5E
title: 'Scanner: reset computed ReplayGain when a file''s content changes'
status: triage
priority: low
labels: []
triageKind: bug
workstream: W25
workstreamId: W25-8
order: 0
created: '2026-11-16T20:48:44.889Z'
updated: '2026-11-16T20:48:44.889Z'
---
Found in W25-7 (oscine-replaygain OQ2).

When a rescan sees an mtime/size change and the re-read file has no ReplayGain tags, `upsertTrack` (`src/main/library/store.ts`) keeps all `rg_*` columns and `rg_source = 'computed'`. A replaced file (re-encoded or re-ripped) therefore keeps a stale measurement, and an unforced job never re-queues it. Today the only workaround is the forced "Measure ReplayGain" context-menu action.

**Proposed fix:** when the scanner re-parses a changed file whose row is `'computed'` and the file has no ReplayGain, reset the row to `rg_source = NULL` and null out the four values, so it shows up as missing and the post-scan nudge picks it up. Drop any staged ReplayGain rows for that track in the same transaction (Decision F).

**Interacts with the RG-6 known gap (OQ5):** an album-only file (track gain deselected at review) is re-read as `'tag'` with a null track gain. Both should be handled by one rule about computed scopes the file lacks, so settle them together.

**Tests:** a changed untagged file resets a computed row; an unchanged file keeps it; a changed file with tags still becomes `'tag'`.
