---
taskId: 01M0XBPPS0B71RJRWXNEVS3G20
title: 'Tooltip consistency pass: native title → UTooltip (G10)'
status: in-review
labels:
  - ui
workstream: W14
workstreamId: W14-14
workstreamDependsOn:
  - W4
order: 2
created: '2026-08-25T21:02:32.223Z'
updated: '2026-08-25T23:22:15.596Z'
---
Per wiki `1-0-polish-and-qol` **G10**. Prefer `UTooltip` for UI consistency where tooltips are currently native HTML `title` attributes. Keep a semantic fallback where it matters (accessibility, non-hover contexts). Audit the renderer for `title=` usages and migrate the UI-chrome ones.
