---
taskId: 01KYXFX1QE0G4TSFW4G9HAKCFF
title: Episode downloads and playback from disk
status: done
priority: high
labels:
  - D16
  - D1
  - shipped
workstream: W9
workstreamId: W9-2
order: 12
created: '2026-08-01T01:44:30.701Z'
updated: '2026-08-01T01:44:30.701Z'
---
## Scope

- Download an episode to a machine-local podcasts directory, streamed to disk with a stall guard and a byte cap, reporting progress over an emit channel.
- `rel_path` relative to that directory, POSIX-normalised on write and rejoined per-platform on read — the same invariant `tracks` obeys, so nothing absolute is ever stored.
- Play episodes through the existing `fermata:` protocol on its own `episode` hostname and a negative playback id space, so the `AudioEngine` interface is untouched.
- Delete, keep-last pruning, played state and resume position.

## Acceptance

- **D1 holds literally**: no audio arrives over the network. A dropped connection during a download cannot become a dropout during playback, because playback only ever reads a completed local file.
- A cancelled or failed download leaves no partial file behind.
- Seeking inside a long episode issues a Range request and does not restart from byte zero.
- The renderer never learns the podcasts directory path.

## Notes

Shipped. The `serveLocalFile` extraction in `src/main/library/trackFiles.ts` is shared with track serving rather than duplicated, so Range and CORS handling has one implementation.
