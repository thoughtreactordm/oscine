---
taskId: 01M0XBN7MH9ZWSVGZZT7436G96
title: 'Podcasts: auto-refresh episodes on show visit (P3)'
status: in-progress
labels:
  - podcasts
workstream: W14
workstreamId: W14-3
workstreamDependsOn:
  - W9
order: 0
created: '2026-08-25T21:01:43.952Z'
updated: '2026-08-26T19:03:03.880Z'
---
Per wiki `1-0-polish-and-qol` **P3**. Refresh a podcast's episode list automatically when its show page is opened, respecting a sane min-interval so rapid re-visits don't hammer the feed. Reuse the existing feed-refresh path in `stores/podcasts.ts`.
