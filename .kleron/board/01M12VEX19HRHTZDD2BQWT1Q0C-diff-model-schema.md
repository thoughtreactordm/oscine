---
taskId: 01M12VEX19HRHTZDD2BQWT1Q0C
title: Diff model & schema
status: done
priority: high
labels:
  - phase-1
  - schema
  - main
workstream: W16
workstreamId: W16-1
order: 4
created: '2026-08-28T00:14:05.864Z'
updated: '2026-08-28T19:48:16.239Z'
---
Design authority: wiki `oscine-tag-writeback` (D28) → "The diff model" + "Schema".

Establishes the **pending write** — the unit W16-6 reviews and W16-2 flushes. For a track it is the field-level delta between what the file currently holds and what the merged app-side correction layers say it should hold.

**Merge precedence (main process):**
1. `track_overrides` (D7) — title/artist/album/track/disc, **extended here** with `genre TEXT` and `year INTEGER`.
2. W15 `track_tags` where `source IN ('user','suggested')` — the free-form user layer W15 names as "precisely the diff to flush".
3. Canonicalization output (W16-5) — normalized genre from the alias/rules table.

**Critical:** compute the diff against a **fresh read of the file**, never the cached `tracks` row, so out-of-band edits (R7) are detected rather than clobbered.

**Schema — migration 017** (W13 reached 016):
- `track_overrides` += `genre TEXT`, `year INTEGER`. Existing columns unchanged.
- No "pending writes" table — pending state is the computed diff, held renderer-side for the review session.

Acceptance: given a track with file tags + overrides + user tags, the merge yields a correct per-field diff; a file mutated on disk after scan surfaces as a diff against the file, not the row.
