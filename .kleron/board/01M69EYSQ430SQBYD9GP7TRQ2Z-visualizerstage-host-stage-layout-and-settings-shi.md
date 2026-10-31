---
taskId: 01M69EYSQ430SQBYD9GP7TRQ2Z
title: 'VisualizerStage host, stage layout and settings — ships with Bars'
status: in-review
priority: medium
labels:
  - D35.1
  - D35.4
  - D35.5
  - D35.7
  - renderer
  - settings
workstream: W23
workstreamId: W23-4
dependsOn:
  - 01M69EXSYQDAX8PGMYF5P6TCRC
  - 01M69EY3K1GXF65DKYVS3ZJY7J
  - 01M69EYD5286ZNY5WBNJ19DCMD
order: 0
created: '2026-10-31T17:08:45.410Z'
updated: '2026-10-31T20:16:25.494Z'
---
Spec: wiki `oscine-visualizers` → D35.1, D35.4, D35.5 (settings, Zen override), D35.7.

The first shippable slice: a panel island that runs one 2D effect on the stage, with the layout, settings and idle discipline in their final form. The seamless wash handoff is W23-5; here **the CSS wash stays underneath** and the canvas is a transparent `overlay` layer that fades in with emergence.

**Host (`src/renderer/panels/VisualizerStage.vue`)**
- Owns the canvas, the rAF loop, the analysis frame (W23-1), the palette and the flash guard (W23-2), and the cover input (W23-3). Calls `frame(audio, palette, stage, dtSec)` with `StageInputs` as in D35.1.
- **Static registry** at `src/renderer/visualizer/registry.ts`. The canvas element is keyed on `surface`.
- **Lifecycle (D35.7):** runs only while enabled, mounted, `!document.hidden` (it listens to `visibilitychange`), reduced motion is off, and playback is playing or still decaying. `dispose()` on unmount. Nothing is allocated per frame.
- Reduced motion: the toggle stays visible but disabled, with a tooltip saying why.

**Stage layout (`StageView.vue`, D35.4)**
- The host mounts in the wash slot (the first child of the stage `<section>`, `absolute inset-0`). No new z-index.
- The cover cluster moves to the upper-left corner on the scrim pair (amended 2026-10-31 from upper-right; lyrics keep their right-hand column). It moves *without animation* here; the FLIP move is W23-5. Opaque scrim in High Contrast.
- **Lyrics stay:** `LyricsPane` keeps its column on its own darkened scrim panel (settled 2026-10-31). The panel belongs to the stage layout; `LyricsPane` is unchanged.
- The ribbon is suppressed while the visualizer shows, without writing `interface.nowPlayingWaveform`.
- A visualizer toggle beside the lyrics toggle, with the same hover/focus fade and width gate.

**Settings (`src/shared/settings/interface.ts`, after `order: 110`):** the five descriptors in D35.5's table, including `interface.visualizerInZen` (default `false`) and `interface.visualizerQuality` as `portable: false`. The **Zen override:** with `visualizerInZen` on, the visualizer shows while `zen.active`; Zen never writes `nowPlayingVisualizer`; a toggle inside Zen is session-only.

**Effect: Bars** (2D, `overlay`): mirrored log-spectrum bars with falling peak caps from a centre line. Every colour is a function of palette entries, and output is multiplied by `stage.intensity`.

**Also:** amend `fermata-design` §11 to record that visualizers left the deferral list, in the note style of the three items already there.

**Tests:** settings validators (unknown effect id is accepted and preserved); the pure gating predicate (enabled × mounted × hidden × reduced motion × playing/decaying × Zen override) as a truth table.

**Done when:** Bars runs on the stage in the dev build on Linux, the loop is verifiably stopped when hidden, paused-and-settled or under reduced motion, Zen honours `visualizerInZen` without writing the toggle, and the gate passes.
