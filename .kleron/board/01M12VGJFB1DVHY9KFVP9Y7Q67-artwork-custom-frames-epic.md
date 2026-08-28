---
taskId: 01M12VGJFB1DVHY9KFVP9Y7Q67
title: Artwork & custom frames (epic)
status: in-review
priority: low
labels:
  - phase-3
  - main
workstream: W16
workstreamId: W16-8
dependsOn:
  - 01M14AAX89PCX250PBPVDN7QGK
  - 01M14ABB9S41XF5NR34GV3C4AN
  - 01M14ABNB9PG2QS6934W1MHZ9E
  - 01M14AC6FN6HN92JVRQRDN5PB7
  - 01M14ACETGA3WTRWG0KBF1Z9DP
order: 0
created: '2026-08-28T00:15:00.586Z'
updated: '2026-08-28T17:32:58.175Z'
---
Design authority: wiki `oscine-tag-writeback` → "Embedded artwork & custom frames (W16-9 – W16-13)". **Epic — investigation done, split into five slices; this card just tracks them.**

**Investigation outcome.** The preservation half is already built and gated: the W16-2 engine edits tags **in place** via `node-taglib-sharp`, so artwork and unknown/custom frames survive any scalar write by construction, and the W16-3 corpus already asserts `preserved:artwork` / `preserved:custom-frame` on all five codecs. So this was never "fix data loss" — it is "add cover *writing*", which unlike every text field has **no app-side source layer**.

**Three decisions settled (see wiki for rationale):**
- **A — persistent correction layer.** A chosen cover is stored app-side (not transient in the review session), so the flush stays a stateless D28 projection and a set cover shows instantly, pre-flush.
- **B — replace front, preserve rest.** Write/remove touches only the front-cover picture; back covers, booklet scans and artist images are left untouched.
- **C — album granularity.** Setting a cover fans out to one per-track override row per selected track; storage stays per-track.

**Slices (dependency-ordered):**
- **W16-9** Artwork override layer — migration 020 `artwork_overrides` (tri-state), content-addressed originals store, override-aware cover resolution, refcount GC.
- **W16-10** Artwork ingest — main-process `dialog.showOpenDialog` + one-way `setFromBytes`, sharp validation, per-album fan-out.
- **W16-11** Engine picture write + byte-level verify — replace-front-preserve-rest under the W16-4 backup/rollback chain.
- **W16-12** Artwork model + review UI — `ArtworkDiff`, `WritebackField` += `artwork`, editor cover panel, review artwork row.
- **W16-13** Corpus hardening + custom-frame round-trip — multi-picture + binary/multi-instance frames, new gate checks.

**Cross-card:** W16-7 (retire-on-match reconciliation) is already built for `track_overrides` only. Extending it to also retire a satisfied `artwork_overrides` row and release the originals-store refcount (R8) is **owned by W16-9**, not a W16-7 follow-up — the table does not exist yet, so W16-9 reaches into the completed reconciliation path and adds the artwork case.

Acceptance (epic): all five slices merged; an end-to-end **set cover → review → flush → wipe → re-scan** round trip reproduces the corrected cover from the file alone, with the override retired and the originals store refcount released.
