---
taskId: 01M14ABNB9PG2QS6934W1MHZ9E
title: Engine picture write + byte-level verify
status: done
priority: low
labels:
  - phase-3
  - main
  - R6
workstream: W16
workstreamId: W16-11
dependsOn:
  - 01M12VFDD0R4ZKBG1JKTT96BGK
  - 01M12VFNNDVX875TM1VFTMTPQG
  - 01M14AAX89PCX250PBPVDN7QGK
order: 13
created: '2026-08-28T13:53:42.760Z'
updated: '2026-08-28T19:48:16.342Z'
---
Design authority: wiki `oscine-tag-writeback` → "Embedded artwork & custom frames → Engine" + Decision B (replace front, preserve rest). Extends the W16-2 engine and the W16-4 verify/rollback chain.

**`WritableTags` gains an artwork intent**, resolved fresh from the W16-9 override store at apply time (same R7 fresh-read discipline as the text fields): `{ kind: 'unchanged' } | { kind: 'clear' } | { kind: 'set'; bytes; mime }`.

**`applyWritableTags` (Decision B — replace front, preserve rest):**
- `set` → replace **only** the front-cover picture (ID3 APIC type 3 / the front-cover `METADATA_BLOCK_PICTURE`), leaving back covers, booklet scans and artist images untouched;
- `clear` → remove **only** the front-cover picture;
- `unchanged` → never touch `tag.pictures`.

**Verify-after-write extends to the binary payload (R6):** after the atomic rename, re-read the flushed front cover and confirm its bytes hash-match what was written, alongside the scalar checks. On mismatch, the existing W16-4 rollback restores the captured tag block (which already contains the pictures — so artwork rollback is free; assert it in a test).

Acceptance: setting a cover replaces the front picture and leaves all other pictures byte-identical on every applicable codec; clearing removes only the front cover; a corrupted/short-written cover fails verify and rolls the file back byte-identical to its pre-flush state; verify compares cover bytes by hash, not by presence.
