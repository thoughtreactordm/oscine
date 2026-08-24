---
taskId: 01M0TDQKAZJKWG6K13NPA36W5C
title: 'Renderer: command / action / settings registry'
status: in-review
priority: high
labels:
  - renderer
  - ui
  - D21
  - D22
workstream: W13
workstreamId: W13-7
dependsOn:
  - 01M0TDPXYBEEGNWR6WBNRD7ZCS
  - 01M0TDP6QRS7EBP62F7ZG38R4P
order: 1
created: '2026-08-24T17:40:15.326Z'
updated: '2026-08-24T20:48:07.046Z'
---
Spec: wiki `fermata-quick-access` → D21, D22, Renderer architecture, product rules 4/5.

Fill the Actions and Settings groups the palette shell (W13-5) stubbed. A declarative command registry — `{ id, label, icon, group, keywords, run }`.

**Navigation.** Already wired in W13-5; extend with deep targets (a specific playlist/artist) via the router.

**Actions.** Call **existing renderer paths** — no second play-order builder, no second downloader (product rule 5):
- Play / queue / play next → the renderer queue/playback stores (`queueCommands.ts`, `playback.ts`), the same activation Library and Discover use.
- Download latest episode → the existing W9 podcasts IPC.
Per D22, an action dispatches, closes the palette, and shows a **toast**; ongoing progress lives in the owning panel (downloads in the Podcasts view).

**Settings.** Generate entries from W8's declarative `settings.ts` registry (reuse each key's label + search keywords — do not maintain a second list). Boolean/enum keys **toggle inline with a toast**; anything richer calls `settingsNav.reveal(key)` and closes the palette (the "inline for simple, jump for complex" split).

**Tests** (`tests/renderer/`): an action command dispatches to the right store/IPC, closes the palette, and toasts; a boolean setting flips inline; a complex setting calls `settingsNav.reveal` with its key; the `/` mode lists registry keys and matches on their keywords.

**Done when:** the palette can play an album, queue a track, download a show's latest episode, flip a simple setting inline, and jump to a complex one — each with the right feedback.
