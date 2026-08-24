---
taskId: 01M0N564BESMZQA7TBREDX0J1P
title: Recipe engine — the five local-library extras
status: done
priority: medium
labels:
  - main
  - library
  - D20
workstream: W12
workstreamId: W12-3
dependsOn:
  - 01M0N55P8K3JVM7YXCSKZ5P27V
order: 5
created: '2026-08-22T16:34:42.157Z'
updated: '2026-08-24T17:56:51.568Z'
---
Spec: wiki `fermata-discover-1-0` → recipes 5–9.

Same `compose.ts`, same claimed-id sets, same injected clock. Do not fork the engine. Add five recipe modules and register them in the exclusion order the spec lists — after `artists`, before `unplayed`/`neglected-genre`/`revisit` as written.

**The five.**
- `almost-finished` — albums with a hole; subtitle `{played} of {total} played`.
- `forgotten-favorites` — **track** grain; hearted and cold or never played.
- `because-favorited` — one artist not claimed by `artists`; title `Because you favorited {name}`.
- `neglected-genre` — one large library genre missing from recent listens; title `{genre} you own and ignore`.
- `guest-appearances` — seed performer on an album-artist not in the seed.

**Tests.** The spec's fixture rows for B, C, F, G/H, and the Various-style appearance. An album claimed by `almost-finished` must not also appear on `revisit`. Artist claimed by `artists` must not be the `because-favorited` pick.

**Done when:** all nine recipes run through one `compose` call, thin shelves omit, and the four placeholder tests still pass unchanged.
