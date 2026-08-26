---
taskId: 01M0XBN47MP08Z9KRZS9XFBS5Z
title: 'Podcasts: tabbed left-nav, retire PodcastTabBar (P2)'
status: in-progress
labels:
  - podcasts
  - ui
workstream: W14
workstreamId: W14-2
workstreamDependsOn:
  - W9
order: 0
created: '2026-08-25T21:01:40.467Z'
updated: '2026-08-26T18:52:00.664Z'
---
Per wiki `1-0-polish-and-qol` **P2** (settled). Retire `PodcastTabBar` the way Curate did — navigation moves into the left rail. Swap the two existing side-rail sections so **Subscriptions** sits on top and **Recent** below, then add the **Discover** link into the Subscriptions section and keep it pinned there so the default Discover page stays reachable in rail context. Touches `src/renderer/views/PodcastsSidebar.vue`, `PodcastTabBar.vue` (removed), `PodcastsView.vue`.
