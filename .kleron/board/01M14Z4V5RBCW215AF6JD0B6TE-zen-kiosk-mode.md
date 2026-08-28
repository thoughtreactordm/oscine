---
taskId: 01M14Z4V5RBCW215AF6JD0B6TE
title: Zen / Kiosk mode
status: todo
priority: medium
labels:
  - W14
  - zen
  - kiosk
  - interface
workstream: W14
workstreamId: W14-16
order: 4
created: '2026-08-28T19:56:59.447Z'
updated: '2026-08-28T19:56:59.447Z'
---
A minimal "Zen / Kiosk" display mode for secondary monitors, TVs, and kiosks. A single transient override state (`zen.active`, **not** persisted — resets on restart) that, while on:

- **Structurally removes** the title bar, tab nav (`ShellTabs`), and the persistent Now Playing transport bar (`NowPlaying.vue`) from the `AppShell` grid — the whole bar goes away, not just its contents.
- **Forces OS fullscreen** via a new `windowControls.setFullScreen` IPC bridge (renderer stays off the window API; main owns `win.setFullScreen`). Leaving fullscreen out-of-band (Esc/F11) exits Zen so state can't desync.
- **Promotes `StageView`** (the `now-playing` route view) to fill the window, carrying the full transport surface the bar used to provide.

Does **not** flip the underlying `interface.tabNavBar` / `interface.colorModeToggle` settings — it overrides them while active and restores on exit. On exit, returns to `shell.returnView`.

### Reuse
Extract the transport controls out of `NowPlaying.vue` into a shared component so both the persistent bar and the Zen `StageView` render the same controls (transport, favorite + 3-dot menu, Tunedeck + Queue toggles, Quick Menu drawer) — no duplicated transport.

### Activation surfaces (mirrors the color-mode-toggle pattern)
- **Command palette** — `toggleZenMode` action command.
- **Title-bar View menu** — checkable "Zen mode" item.
- **Optional title-bar button** — gated by a new durable `interface.zenModeToggleButton` setting, sits left of the window controls beside the color-mode toggle.
- **Keyboard shortcut** — `Ctrl/⌘+Shift+Z` (and optionally F11), added to the fixed G6 set.

### Kiosk safety
With all chrome hidden, guaranteed exits: palette, the shortcut, Esc/F11 (fullscreen listener), and a hover-reveal Exit affordance on the stage.

### Settings
- `interface.zenModeToggleButton` (durable boolean, default false) — show the title-bar Zen button. The active state itself is transient (in-store, not a setting).

Builds on G2 (return-to-last-view) and G4 (idle auto-show) which already exist; optional future tie-in: idle timer enters Zen instead of merely navigating.
