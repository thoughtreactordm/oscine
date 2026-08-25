---
taskId: 01M0XBNKV5XTTCBA010QA5FF02
title: >-
  Now Playing tab lifecycle: hide when idle, return to last view on queue end
  (G2)
status: backlog
labels:
  - ui
  - navigation
workstream: W14
workstreamId: W14-6
workstreamDependsOn:
  - W4
order: 5
created: '2026-08-25T21:01:56.452Z'
updated: '2026-08-25T21:01:56.452Z'
---
Per wiki `1-0-polish-and-qol` **G2** (settled). Hide the Now Playing nav tab when nothing is playing. When the active queue ends **naturally** (played through — not paused, not stopped) while Now Playing is showing, navigate back to the **last-visited view** (Library or Curate, whichever the user came from). Requires tracking the pre–Now-Playing view.
