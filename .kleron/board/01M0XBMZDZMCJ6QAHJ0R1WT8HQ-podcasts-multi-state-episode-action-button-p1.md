---
taskId: 01M0XBMZDZMCJ6QAHJ0R1WT8HQ
title: 'Podcasts: multi-state episode action button (P1)'
status: in-progress
labels:
  - podcasts
  - ui
workstream: W14
workstreamId: W14-1
workstreamDependsOn:
  - W9
order: 0
created: '2026-08-25T21:01:35.550Z'
updated: '2026-08-26T17:27:46.422Z'
---
Per wiki `1-0-polish-and-qol` **P1**. Collapse the separate Download and Play buttons on the podcast show page into one button that cycles by download state: `Download` (idle) → `Cancel` (downloading, with progress) → `Play` (ready). The existing per-episode trash affordance (`podcasts.deleteDownload`) and the bulk "Remove downloads" button stay as-is — removal is **not** a state of this button. Touches `src/renderer/panels/PodcastShowPane.vue`.
