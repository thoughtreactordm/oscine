---
taskId: 01KYXFWV8ZJ2VZX4G9ZE263FMG
title: 'Podcast schema, subscriptions and feed refresh'
status: done
priority: high
labels:
  - D16
  - shipped
workstream: W9
workstreamId: W9-1
order: 11
created: '2026-08-01T01:44:24.093Z'
updated: '2026-08-01T01:44:24.093Z'
---
## Scope

- Migration 005: `podcasts` and `episodes`, with no foreign key crossing into `tracks`, `artists` or `albums` and nothing indexed by `tracks_fts` (**D16**).
- Main-process RSS parsing (`src/main/podcasts/rss.ts`) and OPML import (`opml.ts`), both byte-capped.
- Subscribe by feed URL, refresh, unsubscribe. `guid` is the feed's identity for an episode, so a re-published item updates in place instead of duplicating.
- Show artwork through W2's existing thumbnail cache and its worker — one shared `ArtworkImageProcessor`, injected rather than owned, because two sharp workers racing on the same cache directory is the failure this avoids.

## Acceptance

- A feed that changes its own item ordering, or re-publishes an item, does not duplicate rows.
- A feed host that goes quiet mid-response is abandoned on an idle gap rather than waited on, and a response without a truthful `content-length` still cannot exhaust memory.
- `last_error` is shown to the operator and cleared by the next successful refresh.

## Notes

Shipped. Recorded after the fact — this card documents what exists rather than planning it.
