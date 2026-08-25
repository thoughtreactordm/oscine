---
taskId: 01M0XBPPS0B71RJRWXNEVS3G20
title: 'Tooltip consistency pass: native title → UTooltip (G10)'
status: todo
labels:
  - ui
workstream: W14
workstreamId: W14-14
workstreamDependsOn:
  - W4
order: 22
created: '2026-08-25T21:02:32.223Z'
updated: '2026-08-25T22:22:55.871Z'
---
Per wiki `1-0-polish-and-qol` **G10**. Prefer `UTooltip` for UI consistency where tooltips are currently native HTML `title` attributes. Keep a semantic fallback where it matters (accessibility, non-hover contexts). Audit the renderer for `title=` usages and migrate the UI-chrome ones.
