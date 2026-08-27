---
taskId: 01M0XBNVVPD7WHSQVX1SREY13G
title: Now Playing Auto-show on idle setting (G4)
status: done
labels:
  - settings
  - ui
workstream: W14
workstreamId: W14-8
workstreamDependsOn:
  - W8
  - W4
order: 1
created: '2026-08-25T21:02:04.661Z'
updated: '2026-08-26T23:14:07.626Z'
---
Per wiki `1-0-polish-and-qol` **G4** (settled). New Interface setting: after **N** minutes of no in-app interaction while music plays in the background, navigate to Now Playing. Selectable intervals in minutes: 5, 10, 15, 30, 60. Default **off**. Add via the W8 declarative settings registry; needs an app-interaction idle timer that resets on user input and is gated on active playback.
