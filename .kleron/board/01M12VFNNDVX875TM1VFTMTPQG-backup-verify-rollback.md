---
taskId: 01M12VFNNDVX875TM1VFTMTPQG
title: 'Backup, verify & rollback'
status: done
priority: high
labels:
  - phase-1
  - main
  - R6
workstream: W16
workstreamId: W16-4
dependsOn:
  - 01M12VFDD0R4ZKBG1JKTT96BGK
order: 10
created: '2026-08-28T00:14:31.085Z'
updated: '2026-08-28T19:48:16.306Z'
---
Design authority: wiki `oscine-tag-writeback` → "Atomic write + backup + rollback". The recoverability half of R6's mitigation.

- **Backup before rename:** capture the original **tag block** (not a full-file copy — a large FLAC must not double on disk) so a bad write is recoverable.
- **Verify after write:** re-read the flushed tag; on mismatch or failure, **roll back** to the captured original and mark that file failed.
- **Failure isolation:** one file's failure never aborts the batch. The engine returns a per-file outcome (ok / failed + reason) that W16-6 renders.
- Interacts with **R3**: a flush touches watched files; emit self-inflicted-change signalling so the watcher does not trigger a redundant rescan storm.

Acceptance: an injected write failure mid-batch leaves that file byte-identical to its pre-flush state, the rest of the batch completes, and the per-file report names the failure.
