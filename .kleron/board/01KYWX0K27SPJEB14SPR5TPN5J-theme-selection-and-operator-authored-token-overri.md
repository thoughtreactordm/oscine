---
taskId: 01KYWX0K27SPJEB14SPR5TPN5J
title: Theme selection and operator-authored token overrides
status: todo
priority: medium
labels: []
workstream: W8
workstreamId: W8-12
workstreamDependsOn:
  - W4
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 39
created: '2026-07-31T20:14:23.814Z'
updated: '2026-07-31T20:14:23.814Z'
---
W4 owns the token layer. W8 owns choosing a theme and authoring one.

**Blocked on the token layer being real.** `src/renderer/theme/` is a single `main.css` today. This card cannot start until themes are expressed as CSS custom properties that components consume without knowing their values — and when it does start, it is the thing that proves M5's exit criterion: swapping a theme touches zero component code. If this card requires a component edit to work, the token layer is not finished and the finding belongs back in W4.

## Keys

- `theme.mode` — light, dark, or follow-system. Following the system means reacting to the OS change live, on both platforms.
- `theme.name` — the selected built-in theme.
- `theme.overrides` — a map of token name to value, authored by the operator, layered over the selected theme. Durable and exportable.

## Authoring

A token editor listing every token the theme layer defines, with its current value, its source (theme or override), and a revert — the same provenance idea as W8-5, applied to CSS custom properties. Grouped by token category so it is navigable, and searchable, because there will be a lot of them.

Live preview is the default and costs nothing given W8-4: writing an override sets the custom property and the app repaints. No apply button, no preview mode.

An override naming a token the current theme does not define is kept, not dropped — the unknown-key rule again, and it matters here because themes will gain and lose tokens.

## Done when

- Theme swap and override authoring both work with **zero component changes**, and that claim is checked rather than asserted.
- Follow-system reacts to a live OS theme change on Windows and Linux.
- Overrides survive a theme switch and export cleanly in W8-13.
- Contrast is not silently destroyable — at minimum, warn when an override drops text below a legible ratio against its background.
