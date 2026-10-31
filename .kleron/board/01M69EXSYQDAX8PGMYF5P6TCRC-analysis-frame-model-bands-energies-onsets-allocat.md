---
taskId: 01M69EXSYQDAX8PGMYF5P6TCRC
title: 'Analysis frame model — bands, energies, onsets, allocation-free'
status: todo
priority: medium
labels:
  - D35
  - D35.2
  - renderer
workstream: W23
workstreamId: W23-1
order: 0
created: '2026-10-31T17:08:12.885Z'
updated: '2026-10-31T17:37:34.415Z'
---
Spec: wiki `oscine-visualizers` → D35, D35.2.

A pure model that turns one `readWaveform` poll into the `AnalysisFrame` every effect reads. **`@renderer`-free and DOM-free** (relative imports, no injected globals) so Vitest covers it under plain Node, on the `spectrumModel` / `equalizerModel` pattern. Lives in `src/renderer/visualizer/analysisFrame.ts`.

- **`…Into` variants in `spectrumModel.ts`.** `applyHann`, `fftMagnitudes` and `resampleLogAxis` allocate per call today. Add variants that write into caller-owned scratch buffers, and turn the existing functions into thin wrappers so the EQ pane's behaviour and tests are unchanged.
- **The frame model allocates once, at construction**, and nothing per frame.
- **`spectrum`:** 64 log-spaced bands, 30 Hz–16 kHz, mapped onto 0..1 between `SPECTRUM_FLOOR_DB` and `SPECTRUM_CEIL_DB`, then through a slow auto-gain (a time constant of seconds) and attack/release smoothing.
- **`bass` / `mid` / `treble` / `level`:** smoothed band energies and RMS, 0..1.
- **`onset`:** spectral flux (the sum of positive band rises) against a ~1 s running mean times a constant plus a floor, with a 100 ms refractory window. A repeated poll of the same render quantum reads as zero flux, with no special case.
- **Decay, don't snap:** when the read returns false, `waveform` is left untouched, the smoothed values decay, and `silent` is set only once they've settled (the ribbon's `relax()` behaviour).
- **Frame-rate independence:** every time constant is in seconds and driven by `dtSec`, clamped to 0.1 s.
- **No tempo tracking** (deferred).

**Tests:** a 60 Hz sine lands in `bass` and not `treble`; an impulse train at N Hz yields onsets at N Hz and not more; 30 and 60 fps runs of the same signal converge to the same smoothed values; silence sets `silent` only after the decay; a spy on `Float32Array` construction shows zero allocations per frame; the EQ pane's existing `spectrumModel` tests still pass unchanged.

**Done when:** the model and the `…Into` variants are exhaustively unit-tested, and the EQ pane is behaviourally unchanged.
