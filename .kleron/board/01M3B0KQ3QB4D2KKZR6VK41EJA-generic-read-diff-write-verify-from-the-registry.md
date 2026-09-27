---
taskId: 01M3B0KQ3QB4D2KKZR6VK41EJA
title: Generic read + diff/write/verify from the registry
status: done
priority: medium
labels:
  - '1.1'
  - tag-writeback
workstream: W16
workstreamId: W16-17
dependsOn:
  - 01M3B0K85G0NMJA750XPCCCD4T
  - 01M3B0KDSAV680QFJSH85BC1Y3
order: 6
created: '2026-09-25T00:49:25.621Z'
updated: '2026-09-27T00:20:50.338Z'
---
Design: `oscine-tag-writeback` → "The full tag surface", **Decision E** (generic tier) and R6/R7.

## Scope
- **On-demand read through taglib**: a main-process reader that returns a track's current generic-field values by registry key, reading each `Tag` property the registry names. Not `music-metadata` and not the scan path — the value the editor shows must be in the representation the writer writes and verify compares. Nothing is indexed into `tracks`.
- Used twice: to prefill the editor (batch-bounded; loaded lazily when the "All fields" section opens, so a plain title edit never reads N files) and to compute the diff against a fresh read (R7), never a cached value.
- **Diff**: generic fields join `PendingWrite` / `WritebackField` from the registry rather than as hand-added literals. `changed` compares by kind (list by ordered value, int/bool by value).
- **Write**: `WritableTags` gains a generic `fields` map; `applyWritableTags` sets exactly the keys present, via the registry's taglib property — absent keys untouched (same contract as `albumArtist` since `c9ddc5d`). List kinds write native multi-value (Decision G).
- **Verify**: `engine.ts` `verify` extends to every written generic key, re-read through the same taglib accessor; a mismatch fails the file under the existing backup/rollback chain (R6).
- **Retirement**: `retireWrittenOverrides` deletes the flushed `track_tag_overrides` rows after a verified write — the scan-time reconciliation pass never needs to read generic fields.
- Only corpus-admitted fields (W16-16) are flushable; a non-admitted key is refused at the engine, not just hidden in the UI.

## Acceptance
- Engine tests with injected `applyTags`/`read`: set, clear, list, bool, int; verify catches a mismatched field and rolls back; untouched keys are never assigned.
- scan → correct (generic field) → flush → wipe → rescan leaves `track_tag_overrides` empty and the file holding the value.
