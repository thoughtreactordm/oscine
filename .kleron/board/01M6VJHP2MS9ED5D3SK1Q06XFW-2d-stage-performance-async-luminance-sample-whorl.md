---
taskId: 01M6VJHP2MS9ED5D3SK1Q06XFW
title: '2D stage performance — async luminance sample, Whorl to WebGL'
status: in-progress
priority: medium
labels:
  - D35.6
  - D35.8
  - renderer
  - webgl
  - performance
workstream: W23
workstreamId: W23-16
order: 0
created: '2026-11-07T17:57:49.771Z'
updated: '2026-11-07T18:37:49.089Z'
---
## Problem

2D effects — Whorl worst — run badly on Windows (18 fps at 1440p, the whole renderer janky).
WebGL effects are fine.

## Measured (Windows, RTX 4070 Ti SUPER, Ganesh over ANGLE/D3D11, 2560×1326 stage)

`scripts/stage-frame-probe.mjs`, `stage-trace-probe.mjs`, `stage-cpu-probe.mjs`:

- **The 2D flash-guard sample is the main-thread cost.** `sampleLuminance`'s `drawImage` of the
  effect canvas was 66% of the renderer main thread. Any synchronous read of a 2D canvas — 8×8
  `drawImage`, a 1×1 `getImageData`, even a 1×1 `readPixels` after a GPU copy — costs 50–60 ms
  here, on either raster. Deferring the read to a post-frame task does not help (the first
  "free" measurement was confounded by the in-frame read having already paid).
  `texImage2D(canvas)` into WebGL is 0.1 ms: GPU to GPU, nothing waits.
- **Whorl's own raster is ~28 ms/frame** (plus ~15 ms read overhead in the test harness) on
  either backend, scaling with rings × points, barely with line width. Off the main thread when
  nothing reads, but it still caps how often the canvas actually updates — stubbing the sample
  restored rAF to 58.6 fps without the stage looking smoother.
- Ruled out: CPU vs GPU raster (the earlier `raster: 'cpu'` attempt, reverted in 6952138), CSS
  blur / backdrop-filter (~1 fps), GPU selection (Chromium is on the RTX).

## Scope

1. **Async 2D luminance sample.** On the 2D tier the host copies the effect canvas into a helper
   WebGL2 context and reads it through `gl/lumaReadback.ts`'s fenced pixel-pack path, as the
   WebGL tier already does. No synchronous read of the effect canvas. Falls back to the current
   synchronous sample when no WebGL2 context can be had (a software-rendered canvas, where the
   read is cheap anyway).
2. **Whorl ported to the WebGL2 tier.** Same look, knobs and settings id; the tunnel model split
   out pure and tested; every ring in one instanced draw.
3. The three probe scripts kept under `scripts/`.

## Not in scope

- Trace (same structure as Whorl) — follow-up if it measures badly after (1).
- The waveform ribbon.
- A 2D resolution budget.

## Acceptance

- Bars and the other 2D effects: renderer main thread not dominated by the sample; flash guard
  still fed at ≥ `MIN_SAMPLE_RATE_HZ`.
- Whorl visibly smooth at 1440p on Windows; no regression on Linux.
- Whorl unavailable (not broken) when the WebGL tier is; its stored id falls back as D35.6 says.
- lint, typecheck, test, format green.
