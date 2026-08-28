---
taskId: 01M14ABB9S41XF5NR34GV3C4AN
title: Artwork ingest
status: in-progress
priority: low
labels:
  - phase-3
  - main
  - ipc
workstream: W16
workstreamId: W16-10
dependsOn:
  - 01M14AAX89PCX250PBPVDN7QGK
order: 1
created: '2026-08-28T13:53:32.472Z'
updated: '2026-08-28T14:29:47.298Z'
---
Design authority: wiki `oscine-tag-writeback` → "Embedded artwork & custom frames → Ingest" + Decision C (album granularity). Feeds the W16-9 override layer.

The renderer never touches the filesystem, so all image ingest is **main-process only**.

**Required — file dialog:** a typed IPC where the renderer asks main to open `dialog.showOpenDialog` (image filter). Main reads the chosen file, **validates it with sharp** (decodable JPEG/PNG; refuse undecodable or oversize), stores it in the W16-9 originals store, writes the per-track override row(s), and returns an `ArtworkRef` (present + hash + mime). **Bytes never enter the renderer.**

**Stretch — drag/drop/paste:** the renderer receives a user-provided `Blob` (a gesture, not FS access — allowed under context isolation), reads its `ArrayBuffer`, and ships the bytes **one-way** to main via `setFromBytes(trackIds, bytes, mime)`, which runs the same validate-and-store path.

**Per-album fan-out (Decision C):** setting a cover on a multi-track selection writes one per-track override row for every selected track. Storage stays per-track; "album" is a UI/selection concern only.

Bridge surface (new, typed in `src/shared/ipc.ts`): `artwork.setFromDialog(trackIds)`, `artwork.setFromBytes(trackIds, bytes, mime)`, `artwork.clear(trackIds)` (tri-state clear), `artwork.revert(trackIds)` (drop the override).

Acceptance: an operator picks an image via the dialog and every selected track gains a `set` override pointing at the stored, validated original; `clear` and `revert` set the clear / absent states; an undecodable or oversize file is refused with a typed error and nothing is stored; no image bytes cross into the renderer on the dialog path.
