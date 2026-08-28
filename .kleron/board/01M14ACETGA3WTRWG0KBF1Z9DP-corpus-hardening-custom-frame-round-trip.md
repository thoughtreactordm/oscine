---
taskId: 01M14ACETGA3WTRWG0KBF1Z9DP
title: Corpus hardening + custom-frame round-trip
status: todo
priority: low
labels:
  - phase-3
  - test
  - gate
workstream: W16
workstreamId: W16-13
dependsOn:
  - 01M12VF3AAEPVY8JQ0GCW2N3JG
  - 01M14ABNB9PG2QS6934W1MHZ9E
order: 12
created: '2026-08-28T13:54:08.847Z'
updated: '2026-08-28T13:54:08.847Z'
---
Design authority: wiki `oscine-tag-writeback` → "Test corpus (W16-3)" (extension) + "Embedded artwork & custom frames". Widens the W16-3 gate so the preservation guarantee still holds once the engine *writes* pictures instead of only reading past them.

The current corpus proves only the easy case: **one** seeded picture and **one** simple custom frame, surviving an unrelated scalar edit (`preserved:artwork` / `preserved:custom-frame`). That is passthrough, not the write path.

**Extend the fixture** (same generated-not-scavenged discipline; both platforms measure the same thing): seed each codec's file with **multiple pictures** (front cover + back cover) and both a **binary** custom frame and a **multi-instance** custom frame (e.g. two `COMM`/`TXXX` distinguished only by description).

**New gate checks**, round-tripped through **both** taglib and the app's `music-metadata` reader (so a re-scan produces the expected new cover hash):
- `written:artwork` — after setting a new front cover, the front-cover bytes equal the expected image;
- `preserved:back-cover` — the non-front picture survives byte-identical;
- `removed:artwork` — a clear removes only the front cover; the back cover survives;
- `preserved:custom-frame` — the binary and multi-instance frames both survive a write.

Gate philosophy (matches M1/M2): anything it flags becomes a triage card, never a quiet fix folded into the flush path.

Acceptance: the extended fixture builds identically on both platforms; all new checks are green across every applicable codec through both readers.
