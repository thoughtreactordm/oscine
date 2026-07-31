---
taskId: 01KYTKXXN4164BPB9712CRNT6T
title: 'Main-process fetch layer — rate limiting, retries, IPC contract'
status: todo
priority: high
labels:
  - M7
  - phase-2
  - main
workstream: W7
workstreamId: W7-7
dependsOn:
  - 01KYTKXNGSRRBNQEF2W1SY93P3
order: 12
created: '2026-07-30T22:57:10.307Z'
updated: '2026-07-30T22:57:10.307Z'
---
## Scope

- The only place in the application that opens a socket. Main process only, mirroring the invariant that the renderer never touches the filesystem.
- Rate limiter honouring MusicBrainz's ~1 request/second ceiling, with an identifying User-Agent per their policy.
- Timeouts, bounded retry with backoff, and cancellation of in-flight work when the drawer closes.
- Typed IPC surface, starting in `src/shared/ipc.ts` rather than in a handler.

## Acceptance

- No `fetch`/XHR to any external host exists anywhere under `src/renderer` — reviewed, and worth a lint rule if it is cheap.
- Rate limiter proven by a test that fires 20 concurrent requests and asserts the observed spacing.
- Closing the deck cancels in-flight requests; a fast open/close/open cycle does not leak work or double-fetch.
- Every failure mode — offline, timeout, 503, rate-limited — surfaces as a state the UI can render, never as an exception thrown into a component.

## Notes

**D14**, and the primary mitigation for **R5**'s secondary rate-limit concern. Shuffle-heavy listening must not be able to saturate MusicBrainz; drawer-scoped fetching plus this limiter are the two things standing between us and a ban.
