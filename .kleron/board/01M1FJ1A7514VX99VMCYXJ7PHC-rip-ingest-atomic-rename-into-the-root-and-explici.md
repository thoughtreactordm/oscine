---
taskId: 01M1FJ1A7514VX99VMCYXJ7PHC
title: 'Rip: ingest — atomic rename into the root and explicit reconcile'
status: backlog
priority: medium
labels:
  - cdrip
  - library
  - scanner
  - invariant
workstream: W18
workstreamId: W18-6
dependsOn:
  - 01M1FJ0P2N21SZFS5S8890MFHD
order: 20
created: '2026-09-01T22:39:31.045Z'
updated: '2026-09-01T22:39:31.045Z'
---
## Intent

The last twenty metres: get the finished temp file into the root under its final name and get the
library to know about it. Small card, but it carries the path invariant and the "automatically
indexed and ready to go" promise, so it is specified rather than folded into W18-5.

## Why this is nearly free

W2 already built the whole ingest path. `RootDirectoryWatcher` observes the root, waits out its
settle window — it takes two `stat` snapshots 250 ms apart and rejects anything still changing, so
a half-written file is naturally excluded — and hands stable paths to `reconcilePaths(store, root,
absPaths, deps)`. A ripped file appearing in a watched root is indistinguishable from one the
operator copied in, which is exactly what D29 asserts.

So this card builds almost nothing. It makes two things certain.

## 1. Rename, never write in place

The encoder writes `<final>.<random>.part`; this card `rename`s it to the final name. The watcher
then only ever observes a complete file, which removes the settle window from the critical path
instead of relying on it. Same discipline as W16's atomic write, same reason.

Same-directory rename keeps it same-device and therefore atomic — W18-4's destination validation is
what guarantees that, which is why it rejects a cross-device destination up front.

## 2. Reconcile explicitly — do not rely on the watcher

`library.watcherEnabled` defaults true but **can be false**, and a rip that silently fails to index
on a machine with the watcher off is a bug report nobody can reproduce. So after the last rename,
call `reconcilePaths(store, root, rippedAbsPaths, deps)` directly with the paths just written.

Indexing becomes deterministic and the watcher's later pass is a harmless no-op — `reconcilePaths`
is idempotent on unchanged files, which is the property that makes doing both safe rather than
redundant.

Report the resulting track ids in `RipReport` so W18-6 can offer "show these in the library" and so
a future card could queue them.

## The invariant

Every path stored goes through `toRelPath(root.path, absPath)` with the `rootId` W18-4 resolved.
**Never store an absolute path in `tracks`.** A rip must not be the one code path in the app that
puts an absolute path in the database — that would break D11's export bundle and every
Windows/Linux move, and it would be discovered a year later by someone else.

## Files

- `src/main/cdrip/ingest.ts` — rename, collision policy application, reconcile call
- `src/main/cdrip/service.ts` — the call site at end of rip

## Tests

- Rename is same-directory and the `.part` file is gone afterwards.
- Each collision policy: `skip` leaves the existing file untouched and reports `skipped`;
  `overwrite` replaces it; `suffix` produces ` (2)` and does not loop forever at high collision
  counts.
- `reconcilePaths` is called once with exactly the ripped paths, and calling it a second time (the
  watcher's pass) is a no-op.
- Every stored path is relative and POSIX-normalised — assert on the DB rows, not on the call
  arguments, so a regression in `toRelPath` usage is caught here too.
- A cancelled rip leaves no `.part` files in the destination.

## Out of scope

No artwork embedding beyond what W18-5 already applied. No auto-play or auto-queue of the ripped
album. No eject.
