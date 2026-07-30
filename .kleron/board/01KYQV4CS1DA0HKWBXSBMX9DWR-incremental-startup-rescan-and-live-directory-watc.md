---
taskId: 01KYQV4CS1DA0HKWBXSBMX9DWR
title: Incremental startup rescan and live directory watcher with R3 degradation
status: done
priority: high
labels:
  - M3
  - library
  - watcher
  - cross-platform
  - R3
workstream: W2
workstreamId: W2-6
dependsOn:
  - 01KYECGN8JRHFBMDEBTRS9ZT1E
effort: high
order: 4
created: '2026-07-29T21:05:19.136Z'
updated: '2026-07-30T13:48:41.153Z'
---
Finish D6's library lifecycle: cheap incremental reconciliation at startup, then live updates while the app is open. This work can proceed while the M2 Windows exit column is outstanding; it has no audio dependency.

## Scope

- At startup, reconcile every root by relative POSIX-normalized path plus stored mtime/size: add new files, reparse changed files, delete vanished files, and leave unchanged files untouched.
- Preserve a track's stable id when its file remains the same logical entry so later playlist references are not broken by an ordinary metadata change.
- Watch directories rather than individual files. Coalesce noisy add/change/unlink/rename bursts and avoid parsing a file while an application is still writing it.
- Feed changes through the same scanner/store transaction path used by a manual scan so tracks, dimensions and FTS state cannot drift.
- Own watcher lifecycle explicitly: one watcher set per root, no duplicate subscriptions after rescan, and complete cleanup on root removal/app shutdown.
- Catch Linux `ENOSPC` explicitly per R3. Degrade that root to startup-scan-only and send a typed, visible notice that explains `fs.inotify.max_user_watches`; never fail silently or loop retries.
- Treat recoverable parse races and permission errors as surfaced per-file findings without aborting the watcher.
- Provide injectable watcher adapters/faults so add/change/delete/rename and `ENOSPC` are deterministic unit tests on every platform.

## Explicitly not in scope

Polling as a permanent second watcher, automatically editing OS limits, tag write-back, cloud/removable-drive synchronization, or root-management UI beyond the status needed to explain degraded mode.

## Acceptance

- A no-change startup touches no track metadata rows and performs no metadata parses.
- Add, modify, rename and delete operations become correct library/search results after the debounce window without a full-root rescan.
- Restarting during or after a burst converges to the same database as a clean full scan.
- Injected `ENOSPC` leaves the library usable, records startup-scan-only state and produces one actionable renderer notice.
- Watch count scales with directories, not tracks, and repeated rescans do not grow handles/listeners.
- Tests run on Windows and Linux; platform-specific filesystem behaviour stays behind the adapter rather than leaking into stored paths or UI contracts.
