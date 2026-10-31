---
taskId: 01M69EY3K1GXF65DKYVS3ZJY7J
title: Palette model and flash guard
status: todo
priority: high
labels:
  - D35.3
  - D35.8
  - R17
  - renderer
  - safety
workstream: W23
workstreamId: W23-2
order: 1
created: '2026-10-31T17:08:22.752Z'
updated: '2026-10-31T17:37:34.468Z'
---
Spec: wiki `oscine-visualizers` → D35.3, D35.8, R17.

Two pure models in `src/renderer/visualizer/`, both **`@renderer`-free and DOM-free**. The guard is R17's mitigation and must exist before any effect ships, which is why this card is a prerequisite of the host.

**Palette (`palette.ts`)**
- Input: a resolved-token map, which the host gets via `getComputedStyle` on `onThemeChange` (the `WaveformRibbon` precedent). The model itself never touches the DOM.
- Holds every step of `--oscine-color-primary-<step>`, `--ui-primary`, `--ui-bg`, `--ui-bg-elevated`, `--ui-text-highlighted` and `--ui-text-muted`. Each is exposed as a CSS string (for 2D) and as linear RGB in one `Float32Array` (for shader uniforms).
- **OKLab lerp over ~600 ms** towards a new target, so effects see continuous colour whether a change arrives as one step (switching themes) or as a stream (the 320 ms reactive-accent fade).
- High Contrast: no special casing in the model, but a test pins that its ramp resolves without NaNs or out-of-gamut values.
- The model never reads `theme.reactive`. Reactive colour arrives through the ramp.

**Flash guard (`flashGuard.ts`)**
- An onset/energy envelope with a minimum attack, so no input goes from rest to peak in one frame.
- A luminance monitor fed the mean luminance of a tiny downsample of the rendered frame. When frame-to-frame swings exceed the threshold more than three times in a one-second window (WCAG 2.3.1), it damps the `intensity` multiplier, and lets it recover slowly afterwards.
- **Always on.** The threshold is a constant, not a descriptor, flag or per-effect opt-out (settled 2026-10-31).
- A palette change must not register as a flash; the 600 ms lerp handles it, and a test proves it.

**Tests:** palette lerp endpoints and midpoint in OKLab; a theme flip mid-lerp retargets smoothly; an 8 Hz full-scale onset train produces ≤ 3 large luminance swings per second after the guard; a 2 Hz train passes through undamped; recovery after a strobe passage is gradual; a dark→light theme flip passes without damping.

**Done when:** both models are unit-tested to the above, and the guard's API is the only way an effect gets `intensity`.
