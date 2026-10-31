---
taskId: 01M69EZP5477S8033Q23WW6W2E
title: '2D effects — Halo, Trace and Mosaic'
status: todo
priority: medium
labels:
  - D35.9
  - D35.12
  - renderer
  - effect
workstream: W23
workstreamId: W23-7
dependsOn:
  - 01M69EZ4X26HYEWBC126G2R70S
order: 6
created: '2026-10-31T17:09:14.530Z'
updated: '2026-10-31T17:37:34.750Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.12 (`overlay` / `grow`), D35.11 (cover input).

Completes phase 1's effect set on the 2D tier. **Mosaic** is the first `grow` effect, and it proves that contract before the GPU tier exists.

- **Halo** (`overlay`, `needs.cover`): a radial spectrum ringing a disc of the cover, pulsing on onsets. The disc is drawn from `cover.current.bitmap`, mixed with `previous` during a crossfade.
- **Trace** (`overlay`): the waveform as a slow-drifting ribbon with fading afterimages. The afterimage persistence is `dtSec`-driven, not per frame.
- **Mosaic** (`grow`, `needs.cover`): the cover, fitted like the wash, cut into a grid of tiles (one spectrum band per tile, or band groups), which lift, tilt and settle. **At emergence 0 the tiles close up into exactly the wash** (`stage.wash`), and displacement scales up from zero with emergence. Cheap enough at 2D: one `drawImage` per tile per frame.

All three:
- every colour is a function of palette entries (or the cover, for the cover effects), never a literal hue;
- output is multiplied by `stage.intensity` (the always-on flash guard);
- motion is `dtSec`-driven and frame-rate independent;
- nothing is allocated per frame.

**Tests:** effect modules construct, resize, run a few hundred frames and dispose against a stub 2D context without throwing or allocating per frame; Mosaic's pure tile-layout function returns a gapless grid at emergence 0.

**Done when:** all three run in the dev build, Mosaic held at emergence 0 (`VITE_VISUALIZER_HOLD_EMERGENCE=0`) is indistinguishable from the CSS wash, and cycling through all four 2D effects is seamless.
