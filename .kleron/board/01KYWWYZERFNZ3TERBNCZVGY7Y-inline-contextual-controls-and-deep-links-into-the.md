---
taskId: 01KYWWYZERFNZ3TERBNCZVGY7Y
title: Inline contextual controls and deep links into the settings view
status: in-review
priority: medium
labels: []
workstream: W8
workstreamId: W8-8
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 3
created: '2026-07-31T20:13:30.966Z'
updated: '2026-08-01T06:05:30.467Z'
---
The half of the UX decision that keeps the settings view from becoming the only way to change anything.

A setting is easiest to reason about next to what it affects. A gear on a panel opens a small popover holding that panel's subset — track grouping and art size on the track list, crossfade on the transport, watcher behaviour on a root row. The operator adjusts in place, sees the effect immediately (W8-4 guarantees that), and never leaves the library.

## One definition, two renderings

The popover renders from the **same descriptors** as the full view. It is a filtered projection, not a second UI. A setting must not be able to appear in one and not the other by accident, and its label and help must not diverge — this is the failure mode of every hand-written settings dialog and the registry exists to prevent it.

A panel declares which keys it surfaces (by key or by category), and the popover is generated from that list.

## Deep links

Every inline control carries a link to its row in the full settings view, using the addressing established in W8-6 — opens the view, expands the category, scrolls to and highlights the row. This is what makes the popover safe to keep small: it holds the three knobs used often, and the way to everything else is one click, not a hunt.

The reverse is worth having too where it is cheap: a row in the full view that names where it also appears.

## Done when

- At least three panels surface inline controls, including one cascading key rendered in an entity context so W8-5's inheriting/overridden affordance gets exercised outside the settings view.
- A test asserts a popover and the full view render the same descriptor identically — same label, same help, same control.
- Deep links land on the right row with the category expanded.
- Panels remain islands: an inline control must not reach into a sibling panel's state.
