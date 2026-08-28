---
taskId: 01M12VFDD0R4ZKBG1JKTT96BGK
title: Atomic tag-write engine (main)
status: in-review
priority: high
labels:
  - phase-1
  - main
  - R6
workstream: W16
workstreamId: W16-3
dependsOn:
  - 01M12VF3AAEPVY8JQ0GCW2N3JG
order: 2
created: '2026-08-28T00:14:22.623Z'
updated: '2026-08-28T01:25:25.919Z'
---
Design authority: wiki `oscine-tag-writeback` → "The write engine" + "Atomic write + backup + rollback". Owns **R6 (tag-write corruption)** — the one Oscine operation that can destroy an operator's file.

**Main-process only** (renderer never touches the filesystem — invariant). Per-codec writers behind one interface: ID3v2 for mp3/aac, Vorbis comments for flac/vorbis/opus. **Audio stream bytes are never rewritten — only the tag region.**

**Atomicity (D7's "atomic-write handling" precondition):**
- Temp file in the same directory → `fsync` → atomic `rename` over the original. Never mutate in place.
- After rename, re-read and verify the tag reads back as intended.
- Cross-platform: respects relative-path/root rules; no backslash literals, no platform branches (`oscine/no-windows-path-literals` applies).

**Library selection is a sub-decision of this card, not a given.** Constraint: avoid adding a third native-ABI addon on top of sharp + node-web-audio-api (see CLAUDE.md packaging notes / `verify:native`). Leading candidate: **`node-taglib-sharp`** (pure-TS taglib port; writes ID3 + Vorbis + FLAC + pictures). Confirm it round-trips all five codecs on both platforms (via W16-3) before adopting. `music-metadata` is read-only and cannot be the writer.

Acceptance: writes each v1 codec's tags atomically, verified by read-back on the W16-3 corpus on both platforms; refuses out-of-set formats explicitly.
