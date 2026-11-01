---
taskId: 01M69EZDK5BTVDAS30ANHXZ8NV
title: 'Visualizer controls — next/previous, cycle, shortcuts, palette commands'
status: in-review
priority: medium
labels:
  - D35.5
  - renderer
  - shortcuts
workstream: W23
workstreamId: W23-6
dependsOn:
  - 01M69EYSQ430SQBYD9GP7TRQ2Z
order: 0
created: '2026-10-31T17:09:05.764Z'
updated: '2026-10-31T22:27:30.329Z'
---
Spec: wiki `oscine-visualizers` → D35.5.

How the operator steps through effects.

- **Next/previous** step through the *available* effects (later, W23-8 can make WebGL ones unavailable), wrap at the ends, and write `interface.visualizerEffect`. Each switch goes through the host's switch path (a plain fade until W23-5 lands, then through the wash).
- **Label caption:** on every switch the effect's `label` shows briefly on the stage as a small caption on the scrim, then fades out.
- **Unknown-id fallback:** a stored id missing from the registry, or unavailable on this machine, resolves at runtime to the first available effect, **without rewriting the setting**.
- **Cycle:** `interface.visualizerCycle` = `'track'` advances in registry order on each track change, and `'shuffle'` picks a different available effect at random. `'off'` does nothing. The cycle never picks an unavailable effect.
- **Keyboard:** three entries in the fixed `SHORTCUTS` table (`src/renderer/shell/globalShortcuts.ts`), with a new `ShortcutAction` variant `{ kind: 'visualizer', action: 'toggle' | 'next' | 'prev' }` and a `dispatch` case in `useGlobalShortcuts.ts`. They act only on the stage. Propose the chords and check them against the existing table, the Help modal (which reads the same table) and editable-target exclusion. In Zen, toggle is the session-only override from D35.5.
- **Command Palette:** "Toggle visualizer", "Next visualizer", "Previous visualizer", and one entry per available effect ("Visualizer: Bars"), through W13's command surface.

**Tests:** pure next/prev/cycle selection over a registry with unavailable entries (wrap, skipping, shuffle never repeats the current effect, single-available degenerate case); unknown-id resolution leaves the stored value intact; the `SHORTCUTS` entries resolve and don't collide with existing chords.

**Done when:** every control works from the stage, the keyboard and the palette, and the Help modal lists the new bindings.
