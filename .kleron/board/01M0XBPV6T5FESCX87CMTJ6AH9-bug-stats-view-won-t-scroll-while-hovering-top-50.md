---
taskId: 01M0XBPV6T5FESCX87CMTJ6AH9
title: 'BUG: Stats view won''t scroll while hovering top-50 stat cards (B1)'
status: in-progress
priority: medium
labels:
  - bug
  - ui
workstream: W14
workstreamId: W14-15
workstreamDependsOn:
  - W10
order: 0
created: '2026-08-25T21:02:36.761Z'
updated: '2026-08-26T23:14:20.152Z'
---
Per wiki `1-0-polish-and-qol` **B1**. On the Stats (formerly Listening) view, the page won't scroll vertically while the mouse hovers any of the four large top-50 stat cards — wheel events over the cards are trapped. Wheel over the cards should still scroll the page (likely the cards' own overflow/scroll container swallowing the event when not itself scrollable).
