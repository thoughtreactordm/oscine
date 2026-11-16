---
taskId: 01M7EDBPHH6N9S3MZM8FEG8Z7W
title: Forced re-measure + selection context menu
status: todo
priority: low
labels: []
workstream: W25
workstreamId: W25-7
dependsOn:
  - 01M7EDAVDD2BF7FYSMWK7W4WAA
order: 32
created: '2026-11-15T01:32:44.975Z'
updated: '2026-11-15T01:32:44.975Z'
---
**Phase 3 — RG-7.** Re-measuring already-measured or already-tagged tracks on demand. Depends on RG-4 so that a forced result can be re-staged and the Decision C album-whole rule still holds.

**Scope:**
- `library.startReplayGain` takes an optional `{ trackIds?: number[], force?: boolean }`. `force` queues tracks whatever their `rg_source`, and the `complete()` guard (`WHERE rg_source IS NULL`) accepts a forced item. A forced result **overwrites a `'tag'` value in the database only** — the file is untouched until it is staged and reviewed (RG-6).
- **Library context menu — "Measure ReplayGain"** on a track or album selection. **Album selections are expanded to the whole album** so Decision C can still hold.

**Tests:** a forced re-measure overwrites a `'tag'` row; an unforced one does not.

**Note OQ2 (carry, not necessarily fix here):** does a rescan that detects changed file content reset `rg_source = 'computed'` back to NULL? If not, a replaced file keeps a stale measurement. Record the finding; file a scanner card if it needs a fix beyond this stream.
