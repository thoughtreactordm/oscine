---
taskId: 01M6VJHP2MS9ED5D3SK1Q06XFW
title: CPU raster for path-heavy 2D effects — Whorl's Windows frame rate
status: in-progress
priority: medium
labels:
  - D35.6
  - renderer
  - windows
  - performance
workstream: W23
workstreamId: W23-16
order: 0
created: '2026-11-07T17:57:49.771Z'
updated: '2026-11-07T17:57:49.771Z'
---
## Problem

2D effects — Whorl worst — run badly on Windows and fine on Linux. The old Now Playing waveform
ribbon showed the same thing. WebGL effects are unaffected.

## Hypothesis

Chromium's accelerated 2D canvas on Windows (ANGLE/D3D11, no MSAA) rasterises anti-aliased
paths through software masks the size of each path's bounds, uploaded per draw. Whorl strokes up
to 150 near-full-stage rings per frame. A CPU-backed canvas scan-converts straight into the
backing store instead. Secondarily, the 2D luminance sample (`drawImage` of the accelerated effect
canvas into a `willReadFrequently` 8×8) forces a synchronous full-resolution GPU readback every
other frame; on a CPU-backed effect canvas that becomes a cheap CPU downscale.

## Scope

- `VisualizerEffect.raster?: 'cpu' | 'gpu'` (2D only, default `'gpu'`): `'cpu'` makes the host
  create the effect canvas's context with `willReadFrequently: true`.
- The effect canvas is keyed on surface *and* raster — context attributes stick to a canvas, so a
  switch between the two needs a fresh element.
- Whorl opts in.
- Dev-only `VITE_VISUALIZER_RASTER=cpu|gpu` forces every 2D effect either way, for A/B.

## Not in scope

- Whorl's own path work (join style, batching), the luma two-step downscale, a 2D resolution
  budget. Follow-ups if CPU raster is not enough.

## Acceptance

- Whorl holds frame rate on Windows at 1440p; no regression on Linux.
- Switching Whorl ↔ a GPU 2D effect swaps cleanly through the wash.
- lint, typecheck, test green.
