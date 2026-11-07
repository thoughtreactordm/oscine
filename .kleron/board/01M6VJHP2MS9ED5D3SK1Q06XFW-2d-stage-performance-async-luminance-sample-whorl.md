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
updated: '2026-11-07T19:15:01.281Z'
---
## Problem

2D effects — Whorl worst — ran badly on Windows (18 fps at 1440p, the whole renderer janky).
WebGL effects were fine.

## What was actually wrong (measured, Windows, RTX 4070 Ti SUPER, 2560×1326 stage, 240 Hz)

Four stacked causes, found with `scripts/stage-frame-probe.mjs`, `stage-trace-probe.mjs`,
`stage-cpu-probe.mjs`:

1. **The 2D flash-guard sample** forced each frame's canvas work to finish synchronously on the
   main thread — 50–60 ms per read, any read, either raster. `drawImage` was 66% of the main
   thread. (The `raster: 'cpu'` attempt, cfdfe9b, was the wrong diagnosis; reverted 6952138.)
2. **Path-heavy 2D effects** cost more raster than a frame has: Whorl ~28 ms, Trace ~14 ms,
   Updraft ~14 ms (24 ms spikes). Halo/Gyre ~5 ms, Silk ~1.4, Bars ~0.6.
3. **The stage loop multiplied**: a settled resize's `wake()` inside a frame started a second
   loop. Three were found running at once.
4. **No frame cap above 60 Hz**: `auto`/`high` meant "every display frame", so 240 Hz drew 4× the
   D35.6 budget.

## What shipped

- 5cd3d73 — 2D luminance sampled asynchronously: canvas → helper WebGL2 texture (GPU copy) →
  `lumaReadback`'s fenced readback. Sync read kept only without a hardware context.
- 6ef85b5, 60e243b, 507ab01 — Whorl, Trace, Updraft on the WebGL2 tier. Models split out pure
  and tested; Whorl/Trace share `strokeRenderer.ts` (instanced polylines from shape rows, `ring`
  and `ribbon` layouts), Updraft draws instanced capsules.
- 660dfbf — re-entrancy guard on the stage loop.
- 39ba63d — vsync-divisor pacing: the host learns the refresh and renders every n-th vsync
  (60 Hz→60, 75→75, 120→60, 144→72, 240→60; `low` the same at 30).
- 361c142 — the three probe scripts.

## Results (live, same machine)

| | before | after |
|---|---|---|
| Whorl | 18 fps, main thread 95% busy | WebGL, main thread ~10% busy |
| Trace | ~20 fps, guard fed 5 Hz | WebGL, smooth (operator-confirmed) |
| Updraft | ~14 ms raster/frame | WebGL, main thread 90% idle |
| Halo (2D) | — | 60 fps at 240 Hz, main thread 95% idle, guard 30 Hz |

## Still owed

- Operator visual check of Whorl and Updraft after the port.
- Linux: run the probes; confirm no regression.
- Design doc (`/doc-refine` at workstream end): D35.6 — Whorl/Trace/Updraft are WebGL now; pacing
  is vsync-divisor rather than a fixed interval. D35.8 — the 2D sample is the async WebGL path,
  not "a scaled `drawImage`".
- Not in scope, noted: the guard sits exactly at its 30 Hz floor at 60 fps (pre-existing).

## Acceptance

- [x] 2D effects: main thread not dominated by the sample; guard fed at ≥ `MIN_SAMPLE_RATE_HZ`.
- [x] Whorl measured smooth at 1440p on Windows — visual check owed.
- [ ] No regression on Linux.
- [x] Whorl/Trace/Updraft unavailable (not broken) when the WebGL tier is (D35.6, via glSession).
- [x] lint, typecheck, test (5176), format green.
