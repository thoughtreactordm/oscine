---
taskId: 01M0TDPXYBEEGNWR6WBNRD7ZCS
title: 'Renderer: useGlobalShortcuts + palette shell + title-bar affordance'
status: done
priority: high
labels:
  - renderer
  - ui
  - D21
  - D27
  - RQ1
workstream: W13
workstreamId: W13-5
dependsOn:
  - 01M0TDNEXM17131MG55E72K2EK
  - 01M0TDPGQG2BFA5MT5SN4XE4HR
order: 4
created: '2026-08-24T17:39:53.418Z'
updated: '2026-08-25T21:17:15.141Z'
---
Spec: wiki `fermata-quick-access` → D21, D27, Renderer architecture, RQ1.

The palette's shell and the app's first global shortcut. **RQ1's spike lives here** — verify `UCommandPalette` renders mixed sync/async grouped results with prefix modes before committing the UI; if frame budget slips, window the entity groups or tighten per-group caps.

**`useGlobalShortcuts` (new, minimal — D27).** One composable mounted once in `AppShell.vue`: Ctrl/Cmd+K toggles the palette, Esc closes, guarded so it does not fire inside a focused text control. This is a single registration seam W8's future keyboard-shortcut subsystem absorbs — not a remappable subsystem. Do not scatter a raw `keydown` listener.

**`CommandPalette.vue`.** `UModal` + `UCommandPalette`, mounted in `AppShell.vue` next to `NewPlaylistModal`. Parse the leading prefix (`>`/`@`/`#`/`/`) into a `SearchMode`; debounce `search.query` for the entity groups; render them grouped in the D21 category order. The synchronous Navigation group is wired here (call `useShellStore.setActiveTab`, router for deep targets). Actions and Settings groups are stubs this card — W13-6 fills them.

**Title-bar affordance.** A visible search box/button in `AppTitleBar.vue` that opens the same modal, so the palette is discoverable and not just a hidden shortcut.

**Tests** (`tests/renderer/`): Ctrl/Cmd+K opens and Esc closes; the shortcut does not fire while typing in an input; a prefix sets the mode and scopes `search.query`; selecting a Navigation result switches the active tab and closes the palette.

**Done when:** Ctrl/Cmd+K and the title-bar button both open a palette that fuzzy-finds entities and navigates, at frame budget.
