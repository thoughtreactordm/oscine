---
taskId: 01M69EZP5477S8033Q23WW6W2E
title: '2D effects — Halo, Trace and Mosaic'
status: in-review
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
order: 0
created: '2026-10-31T17:09:14.530Z'
updated: '2026-10-31T22:37:55.626Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.12 (`overlay` / `grow`), D35.11 (cover input).

Completes phase 1's effect set on the 2D tier. **Mosaic** is the first `grow` effect, and it proves that contract before the GPU tier exists.

- **Halo** (`overlay`, `needs.cover`): a radial spectrum ringing a disc of the cover, pulsing on onsets. The disc is drawn from `cover.current.bitmap`, mixed with `previous` during a crossfade.
- **Trace** (`overlay`): the waveform as a slow-drifting ribbon with fading afterimages. The afterimage persistence is `dtSec`-driven, not per frame.
- ~~**Mosaic**~~ — dropped 2026-10-31 after two attempts (lift/tilt, then flip waves) read as hokey. Replaced by four wispy/spinny 2D `overlay` effects: **Whorl** (waveform ring, spiralling afterimages), **Silk** (pendulum-pen threads), **Updraft** (motes on a flow field, smoke trails), **Gyre** (spectrum arcs orbiting concentric rings).

All three:
- every colour is a function of palette entries (or the cover, for the cover effects), never a literal hue;
- output is multiplied by `stage.intensity` (the always-on flash guard);
- motion is `dtSec`-driven and frame-rate independent;
- nothing is allocated per frame.

**Tests:** effect modules construct, resize, run a few hundred frames and dispose against a stub 2D context without throwing or allocating per frame; Mosaic's pure tile-layout function returns a gapless grid at emergence 0.

**Done when:** all three run in the dev build, and cycling through all seven 2D effects is seamless.
