---
taskId: 01M0XBNC37X15C4MX0DV80HHFQ
title: 'Podcasts: auto-download Latest, keep last N (P4)'
status: todo
labels:
  - podcasts
workstream: W14
workstreamId: W14-4
workstreamDependsOn:
  - W9
order: 6
created: '2026-08-25T21:01:48.518Z'
updated: '2026-08-25T22:22:55.679Z'
---
Per wiki `1-0-polish-and-qol` **P4** (settled). Per-pod toggle to auto-download new episodes, retaining the newest **N** downloaded episodes per pod, N configurable per pod (default 3). Pulling a newer one prunes the oldest auto-download beyond N, but never a manually-kept episode. Expose the toggle on the show page **and** as a control on the Subscriptions rail item. Needs a per-pod setting (auto-download on/off + N) and prune logic in the download path.
