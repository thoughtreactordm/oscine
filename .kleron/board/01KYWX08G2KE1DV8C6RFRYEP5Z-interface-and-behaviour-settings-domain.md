---
taskId: 01KYWX08G2KE1DV8C6RFRYEP5Z
title: Interface and behaviour settings domain
status: todo
priority: low
labels: []
workstream: W8
workstreamId: W8-11
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 38
created: '2026-07-31T20:14:12.992Z'
updated: '2026-07-31T20:14:12.992Z'
---
The domain that is nearly free once the registry exists, and that a poweruser will notice the absence of immediately.

## Keys

- Density and row height — must respect the virtualization contract; a row-height change has to invalidate the virtual list's measurements rather than quietly desync them. This is the one entry here that is not trivial.
- Duration, date and file-size formats.
- Double-click action on a track — play now, play next, add to queue, add to viewed playlist.
- Restore session on launch — open playlist tabs, viewed selection, scroll position.
- Confirm before removing tracks from a playlist, before deleting a playlist, before removing a root.
- Close to tray, minimise to tray, start minimised — the tray affordances, if a tray exists by then; drop them from this card rather than building a tray for them.

## Explicitly not here

Keyboard shortcuts. W8 does not own a keymap subsystem, and a settings page for a keymap that does not exist would be a page of nothing. See the workstream description — that gap is real and currently unowned.

## Done when

- Row height and density changes are correct against a virtualized list at scale, tested at the 100k target rather than on a short fixture.
- Restore-session settings integrate with the existing playlist session state (absorbed in W8-3) rather than adding a parallel mechanism.
- Every confirmation toggle actually gates its confirmation — a toggle that is read by nothing is worse than no toggle.
