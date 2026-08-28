---
taskId: 01M12VG7FZX6TVP55TGSG4BW1H
title: Staged batch review UI
status: in-review
priority: medium
labels:
  - phase-2
  - renderer
  - ui
workstream: W16
workstreamId: W16-6
dependsOn:
  - 01M12VEX19HRHTZDD2BQWT1Q0C
  - 01M12VFDD0R4ZKBG1JKTT96BGK
order: 5
created: '2026-08-28T00:14:49.343Z'
updated: '2026-08-28T13:01:31.143Z'
---
Design authority: wiki `oscine-tag-writeback` → "Staged review UI". The operator-facing gate that makes D28 "explicit and staged".

Pending writes (W16-1 diffs) accumulate and are surfaced as a review diff — **old → new, per field, per track** — with per-row and per-field select/deselect. Apply runs the batch through the W16-2/W16-4 engine over IPC with **live progress** and a **per-file success/failure summary**.

**Invariants:** W4 panel-island (no assumptions about neighbours); **virtualized from first commit** (a batch can be thousands of tracks); crosses IPC via a typed channel added to `src/shared/ipc.ts`; theming through the token layer, no hardcoded colours.

Acceptance: the operator can review a multi-thousand-track diff at 60fps, deselect individual fields/rows, apply, and see per-file outcomes including failures surfaced from W16-4.
