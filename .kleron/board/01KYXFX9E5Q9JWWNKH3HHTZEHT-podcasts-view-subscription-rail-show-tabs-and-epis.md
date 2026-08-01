---
taskId: 01KYXFX9E5Q9JWWNKH3HHTZEHT
title: 'Podcasts view: subscription rail, show tabs and episode list'
status: done
priority: medium
labels:
  - D16
  - D4
  - shipped
workstream: W9
workstreamId: W9-3
order: 13
created: '2026-08-01T01:44:38.594Z'
updated: '2026-08-01T01:44:38.594Z'
---
## Scope

- A Podcasts route with its own sidebar: subscription rail plus recent-across-shows, both virtualized.
- Show tabs on the W5 tab-bar pattern, backed by `panels/podcastSession.ts` in renderer storage. Closing a tab does not unsubscribe — the rail is where closed shows live.
- Show pane: header, virtualized episode list, per-episode download/play/delete and played state.

## Acceptance

- Every list is windowed from its first commit, per the standing invariant. A show with several thousand episodes scrolls in frame budget.
- Panels stay islands: nothing in `panels/Podcast*.vue` assumes a neighbour, so a docking system can host them later.
- A hand-edited or stale session file degrades to no tabs open rather than to a broken tab bar.

## Notes

Shipped.
