---
taskId: 01M69F1R8NFQVNDC97DV447SN5
title: >-
  Viewing verification — both platforms, GPU fallback, strobe and wash-match
  checks
status: todo
priority: medium
labels:
  - R16
  - R17
  - verification
  - windows
  - linux
workstream: W23
workstreamId: W23-15
dependsOn:
  - 01M69EZP5477S8033Q23WW6W2E
  - 01M69F09VCN43YFAQW20ZNKBFA
  - 01M69F0HM0HP1DMKGV4VJNZPXE
  - 01M69F0QS2ANXPMR8WZ028R0JR
  - 01M69F0Y0KZRQX19954Y9V72F7
order: 14
created: '2026-10-31T17:10:22.228Z'
updated: '2026-10-31T17:37:35.250Z'
---
Spec: wiki `oscine-visualizers` → R16, R17, D35.6, D35.8, D35.12.

The hardware pass no CI runner can do, run against the operator's own `npm run dev` / packaged builds on **Windows and Linux**. This is the W19-7 listening-verification shape: **anything it flags becomes a triage card, not a fix folded into the run.**

**R16: GPU and driver variance**
- Zen fullscreen at 4K on a discrete GPU and on an integrated GPU; record frame times per effect per quality tier (`auto`, `low`, `high`).
- A forced `--disable-gpu` launch: WebGL effects are hidden from next/prev, the cycle and the palette, a stored WebGL effect falls back without the setting being rewritten, and 2D works.
- Context loss via suspend/resume and via `WEBGL_lose_context`: recovery through the CSS wash with no cut; the second loss disables the tier.
- `auto` backs off on the integrated GPU and the stage stays smooth.
- Idle: no GPU or CPU activity when the window is hidden, the tab is left, playback has been paused and settled, or reduced motion is on.

**R17: photosensitive flashing**
- Every effect against a strobe-heavy track (dense transients, hard cuts) on a bright, high-contrast cover: no more than three full-field flashes per second, observed and from the guard's own counters.
- A dark↔light theme flip while an effect runs is not damped as a flash and doesn't look like one.

**D35.12: seamlessness**
- Every `grow` effect held at emergence 0 (`VITE_VISUALIZER_HOLD_EMERGENCE=0`) against the CSS wash, by screenshot diff.
- By eye: on, off, pause → settle → resume, same-surface switch, 2D ↔ WebGL switch, track change and no-cover tracks, in the normal stage and in Zen, with lyrics on (the darkened lyrics panel) and off.
- Zen with `interface.visualizerInZen` on and off: entering Zen grows the visualizer in, leaving restores the stage toggle's state, and Zen never writes it.
- High Contrast theme: opaque scrims, legible text over every effect.

**Deliverable:** a short report per platform (effects × tiers frame-time table, the fallback and context-loss results, the strobe check results, wash-match screenshots) attached to this card, plus one triage card per finding.
