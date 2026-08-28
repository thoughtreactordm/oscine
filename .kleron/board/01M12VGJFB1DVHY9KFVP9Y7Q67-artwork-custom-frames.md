---
taskId: 01M12VGJFB1DVHY9KFVP9Y7Q67
title: Artwork & custom frames
status: todo
priority: low
labels:
  - phase-3
  - main
workstream: W16
workstreamId: W16-8
dependsOn:
  - 01M12VFDD0R4ZKBG1JKTT96BGK
  - 01M12VFNNDVX875TM1VFTMTPQG
order: 7
created: '2026-08-28T00:15:00.586Z'
updated: '2026-08-28T00:15:00.586Z'
---
Design authority: wiki `oscine-tag-writeback` → "Scope". The largest edge-case surface — deliberately last.

Extend the W16-2 engine to write **embedded artwork** — APIC (ID3, mp3/aac) and METADATA_BLOCK_PICTURE (Vorbis/FLAC) — and to **round-trip arbitrary/custom frames** rather than dropping them on write. All under the same atomic + backup + verify + rollback guarantees (W16-2/W16-4) and covered by the W16-3 corpus (which already includes artwork and a custom frame).

Interacts with the artwork thumbnail cache (W2/W9): a flushed art change must invalidate the cached thumbnail.

Acceptance: artwork writes round-trip on all applicable codecs; a file carrying a custom frame retains it after an unrelated tag flush; the thumbnail cache reflects a changed embedded image.
