---
taskId: 01KYWWY6TM6XQA3NB7YHQWZZG4
title: >-
  Settings view — category rail, search, and controls generated from the
  registry
status: todo
priority: high
labels: []
workstream: W8
workstreamId: W8-6
dependsOn:
  - 01KYWWX4982WY57N4AYGJGXRJR
order: 33
created: '2026-07-31T20:13:05.746Z'
updated: '2026-07-31T20:13:05.746Z'
---
The full settings surface, as a view inside the shell rather than a modal — the library stays reachable, and a setting can be tuned against what it affects.

```
┌─ Fermata ────────────────────────────────┐
│ ⌂ Library  ♫ Playlists  ⚙ Settings       │
├──────────┬───────────────────────────────┤
│ 🔍 gapl… │  Playback ▸ Gapless           │
│ ─────────│                               │
│ Playback │  Gapless playback    [ ●— ]   │
│ Library  │  Crossfade (ms)      [   0]   │
│ Audio    │    └ mutually exclusive       │
│ Interface│  Preferred device  [Auto ▾]   │
│ Keys     │                               │
│ Advanced │  ⟲ Reset section              │
└──────────┴───────────────────────────────┘
```

## Generated, not authored

Every row renders from a registry descriptor: `control` picks the widget, `label`/`help` fill the text, `category`/`order` place it. **Adding a setting must require zero edits to this view.** A descriptor with `control: 'custom'` names its own component — the escape hatch for the genuinely bespoke, and its use should stay rare enough to notice.

`advanced` keys are hidden behind a per-section disclosure. `requiresRestart` renders the badge from W8-4.

## Search

The box filters across key, label, help and `keywords`, matching substrings, and jumps to the matching row with its section expanded and the row highlighted. This is the primary navigation for a surface that will be large — a rail alone stops scaling well before 100 settings.

## Panels are islands

The view is composed of panel components under `src/renderer/panels/` and makes no assumption about its neighbours, per the repo rule — it must survive being docked somewhere else later.

Theming through the token layer only. A settings pane that hardcodes a colour would be a particularly bad look given W8-12.

## Deep-link anchors

Each row is addressable by key so W8-8 can link into it. Establish the addressing here.

## Done when

- The view renders entirely from descriptors, with a test that adds a fake descriptor and asserts it appears with the right control and category without touching the component.
- Search matches on help text and keywords, not just labels.
- The section list is virtualized if a category can exceed a screen — the every-list-is-virtualized rule applies here too.
- Zero hardcoded colours; `npm run lint` and `npm run typecheck` clean.
