---
taskId: 01M7EDBGH600EXJBVJY31A2EKN
title: >-
  Review surface: Stage measured ReplayGain action, deselected mixed-album rows,
  split-album warning, source labels
status: in-review
priority: medium
labels: []
workstream: W25
workstreamId: W25-6
dependsOn:
  - 01M7EDAVDD2BF7FYSMWK7W4WAA
order: 31
created: '2026-11-15T01:32:38.820Z'
updated: '2026-11-16T20:41:08.343Z'
---
**Phase 2 — RG-6.** The operator-facing review, on top of RG-4's staging service and the W16-18 generic review columns.

**Scope:**
- A **"Stage measured ReplayGain"** action in the Tools tab write-back review. Rows render as the generic columns W16-18 already draws.
- **Decision D rows render deselected** — a tagged track whose existing album gain differs from the computed one by more than 0.1 dB is shown but unchecked, so the operator opts in per row.
- **Split-album warning (R21).** Staging is album-whole (Decision C), but the review lets the operator deselect rows and one file can fail its flush — either leaves an album with mixed album gains. The review **warns when a selection splits an album**, and the apply summary **lists albums left partial**. Album-atomic flush is deliberately not attempted (it would mean multi-file rollback, which the writer does not do).
- **After flush (OQ5):** resolve whether the write-back flush re-indexes the file, or whether `rg_source` flips to `'tag'` only on the next scan. The flushed file should be re-read and the track flipped to `rg_source = 'tag'`.
- **Source labels.** Track Info and the Tunedeck Loudness pane say where the value came from: **"from file"**, **"measured — not in file"**, **"measured — staged"**.

**Tests:** renderer review model for the deselected-row and split-album cases, no `@renderer` imports and no DOM.
