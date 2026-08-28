---
taskId: 01M12VGDC5BYX59D9WKH9TAWDY
title: Re-scan reconciliation
status: todo
priority: medium
labels:
  - phase-2
  - main
  - library
workstream: W16
workstreamId: W16-7
dependsOn:
  - 01M12VEX19HRHTZDD2BQWT1Q0C
  - 01M12VFDD0R4ZKBG1JKTT96BGK
order: 6
created: '2026-08-28T00:14:55.365Z'
updated: '2026-08-28T00:14:55.365Z'
---
Design authority: wiki `oscine-tag-writeback` → "Re-scan reconciliation". The card that actually closes the operator's loop — the reason the whole stream exists.

After a successful flush the file tag equals the correction, so the override has done its job. Decide the **override lifecycle**: retire the override once `file == override` vs. retain it as an audit trail.

**Default lean: retire on match.** The point of D28 is that the source no longer needs an override — a wiped, re-scanned library must read clean with an **empty `track_overrides`**. If an audit trail is wanted, it belongs in a separate flush-log, not in the live override rows.

Acceptance: a full **scan → correct → flush → wipe DB → re-scan** round trip reproduces the corrected library from the files alone, with `track_overrides` empty after the wipe+rescan.
