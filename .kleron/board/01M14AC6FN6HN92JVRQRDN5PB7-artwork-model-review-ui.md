---
taskId: 01M14AC6FN6HN92JVRQRDN5PB7
title: Artwork model + review UI
status: todo
priority: low
labels:
  - phase-3
  - renderer
  - ui
  - shared
workstream: W16
workstreamId: W16-12
dependsOn:
  - 01M12VG7FZX6TVP55TGSG4BW1H
  - 01M14AAX89PCX250PBPVDN7QGK
  - 01M14ABB9S41XF5NR34GV3C4AN
order: 11
created: '2026-08-28T13:54:00.308Z'
updated: '2026-08-28T13:54:00.308Z'
---
Design authority: wiki `oscine-tag-writeback` → "Embedded artwork & custom frames" + "Staged review UI". The operator-facing half of the artwork split.

**Shared model (`src/shared/tagWriteback.ts`):**
- `ArtworkRef { present; hash | null; mime | null; width?; height? }` — a *reference* resolved to an `oscine://` thumbnail, **never inline bytes** (a batch is thousands of tracks).
- `ArtworkDiff { current: ArtworkRef; proposed: ArtworkRef; changed }`; `PendingWrite.artwork: ArtworkDiff`.
- `WritebackField` += `'artwork'`; append to `WRITEBACK_FIELDS`. The flush maps a selected `artwork` field to the W16-11 engine intent.

**Editor (`TrackMetadataEditor.vue`):** a cover panel at the top — current cover (override-aware, via W16-9 resolution), a `mixed` state when a multi-track selection disagrees (compilations), and **Set cover… / Remove / Revert to file**, with the same `overridden` badge the text fields use. Actions apply across the whole selection (per-album, Decision C) through the W16-10 bridge.

**Review (`TagWritebackReview.vue` + `TriCheck.vue`):** a new artwork row per track — old thumbnail → new thumbnail with the same per-field select/deselect; "— none" and "✕ remove" states. Inherits the panel-island + virtualization invariants; theming through the token layer, no hardcoded colours.

Acceptance: an operator sets/removes a cover in the editor and sees it immediately (pre-flush); the review shows an old→new artwork thumbnail row that selects/deselects like any field and drives the correct engine intent on apply; artwork bytes never appear in a `PendingWrite` or report; the diff renders at 60fps in a multi-thousand-track batch.
