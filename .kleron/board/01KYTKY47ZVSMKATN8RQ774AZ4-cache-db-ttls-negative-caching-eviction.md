---
taskId: 01KYTKY47ZVSMKATN8RQ774AZ4
title: 'cache.db — TTLs, negative caching, eviction'
status: todo
priority: high
labels:
  - M7
  - phase-2
  - main
workstream: W7
workstreamId: W7-8
dependsOn:
  - 01KYTKXXN4164BPB9712CRNT6T
order: 13
created: '2026-07-30T22:57:17.054Z'
updated: '2026-07-30T22:57:17.054Z'
---
## Scope

- A second SQLite database beside the library, with its own migration runner. Not new tables in the library DB — the separation is what makes it deletable.
- Per-entity TTLs, cached negative results, a size cap and an eviction policy.
- Explicitly excluded from **D11**'s export bundle.

## Acceptance

- A warm artist renders completely with the network physically unplugged.
- An artist that returns 404 is queried once and not re-queried until its negative TTL expires — the specific failure this prevents is re-burning rate limit on every play of an unmatchable artist.
- Deleting `cache.db` while the app is closed loses nothing but speed; the app recreates it.
- The export bundle provably does not contain it, with a test.
- TTLs are configurable and their defaults are justified in the card.

## Notes

**D14**. Follows the precedent set by the artwork thumbnail cache: derived data lives outside the library tables and is disposable by design.
