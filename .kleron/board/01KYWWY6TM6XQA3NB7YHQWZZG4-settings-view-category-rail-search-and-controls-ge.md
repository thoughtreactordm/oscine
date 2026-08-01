---
taskId: 01KYWWY6TM6XQA3NB7YHQWZZG4
title: >-
  Settings view — category rail, search, and controls generated from the
  registry
status: in-review
priority: high
labels: []
workstream: W8
workstreamId: W8-6
dependsOn:
  - 01KYWWX4982WY57N4AYGJGXRJR
order: 33
created: '2026-07-31T20:13:05.746Z'
updated: '2026-08-01T05:18:19.117Z'
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

---

## What landed — 443d6ea

`src/renderer/panels/settings/`

- **`catalog.ts`** — the whole model, pure and `@shared`-only so it tests under plain Node like `listViewport`. Sections, ordering, search matching, advanced disclosure and row addressing. `buildSettingsCatalog(descriptors, options)` takes its descriptors as a parameter, which is the seam the acceptance test needs.
- **`SettingsRail.vue`** — search box and category rail, mounted in the frame's sidebar slot.
- **`SettingsPane.vue`** — the virtualized body, mounted in the main region.
- **`SettingRow.vue`** — label, help, restart badge, control. The unit W8-8's popovers reuse.
- **`SettingControl.vue`** — the only place in the renderer that knows what a `control` hint means. Value-in, value-out: it never reaches for the store, so the same component serves the view, an entity override and an inline popover.
- **`customControls.ts`** — the `control: 'custom'` register. Empty, which is the correct state; a name with no entry renders as a stated gap rather than as nothing.

`src/renderer/stores/settingsNav.ts` — where the surface is looking, and nothing about what a setting is. A store because the rail and the body are two routed components in two slots of the frame.

`src/renderer/views/SettingsView.vue` + the tab in `shell/routes.ts`, which also gains `settingsRouteFor(key)` — the deep-link addressing, beside the route name rather than rebuilt in every panel that grows a gear.

### Decisions worth knowing

- **A query spans every category and opens every advanced disclosure it matched.** Answering only from the section the rail points at would be a search that requires you to already know the answer; hiding a match behind a disclosure is the failure the affordance exists to prevent.
- **Rows are a fixed height** (`SETTING_ROW_PX = 64`), so `visibleRange` needs no measurement. The cost is one clamped line of help, with the full text on the element.
- **The advanced disclosure is a per-category map, not a flag**, and `buildSettingsCatalog` reads it after resolving which category is showing — a caller that had not chosen a section yet would otherwise have to ask, get an answer, and paint the intermediate one. This was a real bug, caught in the live run.
- **The restart badge has two states.** `Needs restart` off the descriptor flag, `Restart to apply` once the store's `restartRequired` says the value has actually moved. Neither is a list.
- **Category icons joined the explicit bundle list** in `electron.vite.config.ts`. `SETTING_CATEGORIES` lives in `src/shared/settings/kernel.ts`, outside the renderer scan root, and four of the six resolved anyway because a component elsewhere names the same icon — which is worse than none resolving, since it reads as a bad icon name rather than a missing scan. `i-tabler-world` would have failed the same way when W7 adds network keys.

### Done when — evidence

- **Renders entirely from descriptors** — `tests/renderer/panels/settingsCatalog.test.ts`, 18 tests. The acceptance one hands `buildSettingsCatalog` three descriptors the registry has never held, in `network` (a category that ships empty), and asserts they arrive with the right control, in the right section, ordered by their own `order`, with the internal one excluded and the advanced one behind the disclosure. No component touched.
- **Search matches help and keywords** — covered in the unit test and in the live run: `thumbnails` appears in one help string and in no label, key or keyword, and finds `library.artworkCacheMb`; `dark mode` is a keyword on `interface.theme` and finds it.
- **Virtualized** — `visibleRange` over uniform rows, the same helper the up-next overlay uses.
- **Zero hardcoded colours** — semantic Nuxt UI classes only (`text-highlighted`, `bg-elevated`, `border-default`, `bg-primary/10`, `color="warning"`).
- `lint`, `format:check`, `typecheck`, `test` (79 files, 1209 tests) and `build` all clean.

### The live run

Second instance against a throwaway user-data directory, driven over CDP.

- The tab and route exist; the rail lists exactly the four categories that hold keys, and `network`/`podcasts` are absent until a descriptor claims them.
- All four shipped control kinds write end to end — toggle, number stepper, slider and select. The select needed real `Input.dispatchMouseEvent` rather than synthetic clicks; synthetic events never reached reka-ui's listbox.
- Writes land in SQLite: `audio.crossfadeMs=250`, `interface.theme="dark"`, `library.artworkCacheMb=576`, `library.watcherEnabled=true`.
- `library.artworkCacheMb` showed `Needs restart` at rest and flipped to `Restart to apply` the moment its value moved.
- The deep link `{ name: 'settings', query: { key: 'library.artworkCacheMb' } }` from another tab selected Library, opened its advanced disclosure, scrolled to `#setting-library-artworkCacheMb` and marked it.
- Advanced disclosure opens and closes; a query discloses an advanced key on its own.

### Left for the cards that own them

- **Reset / revert / changed-from-default** — the mockup's `⟲ Reset section` is W8-7.
- **Inline popovers and the reverse link** — W8-8.
- **A `path` control has no shipped descriptor yet**, so it renders a text input with no folder picker. W8-10 owns roots and should wire the picker when it lands.
- **Keys** — the mockup's `Keys` rail entry stays absent. W8 does not own a keymap subsystem; see the workstream description.
