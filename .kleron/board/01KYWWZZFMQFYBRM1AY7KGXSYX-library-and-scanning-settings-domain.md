---
taskId: 01KYWWZZFMQFYBRM1AY7KGXSYX
title: Library and scanning settings domain
status: done
priority: medium
labels: []
workstream: W8
workstreamId: W8-10
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 12
created: '2026-07-31T20:14:03.762Z'
updated: '2026-08-02T13:14:31.249Z'
---
Everything about how Fermata reads the disk, gathered into one place — including the root folders, which currently have their own ad-hoc surface.

## Keys

- `library.watcher.enabled` and the R3 degradation behaviour — what happens when inotify watch limits are exhausted on a large library. Today that policy is code; as a setting it becomes an operator choice between watching, polling and manual rescan, and the R3 notice can point at the setting that changes it.
- `library.rescanOnStartup` — on, off, or roots-changed-only.
- `library.artwork.cacheSizeMb` and a cache-clear action. Actions are not settings; the registry needs a `control: 'custom'` row or a distinct action affordance for this and for "rescan now" — decide which here and keep it consistent.
- `library.fileTypes` — which extensions are eligible for scan.
- Root folders, re-homed. Add, remove, rename, per-root scan behaviour (cascading — this is the second real consumer of W8-5 after playlist crossfade). Removing a root must keep saying what it will do to the tracks that came from it, wherever that flow ends up living.

## The path invariant is not negotiable

Roots are the one place operator input becomes a stored path. Paths are stored relative to a named root, POSIX-normalised on write, rejoined per-platform on read — and `fermata/no-windows-path-literals` enforces the shape of that code under `src/`. A settings UI that lets a path in must not be the hole in it. Any new path handling here gets the same treatment and the same tests.

## Done when

- Root management works from settings and the previous ad-hoc surface is either removed or is a deep link into it — not a second implementation.
- Per-root scan overrides resolve through W8-5, tested.
- Toggling the watcher takes effect without a restart, or is honestly flagged `requiresRestart`.
- Path portability tests still pass on both platforms; `tests/tooling/pathPortability.test.ts` covers any path literal this card introduces.
