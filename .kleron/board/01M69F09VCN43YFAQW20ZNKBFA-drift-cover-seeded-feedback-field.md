---
taskId: 01M69F09VCN43YFAQW20ZNKBFA
title: Drift — cover-seeded feedback field
status: todo
priority: medium
labels:
  - D35.9
  - D35.12
  - renderer
  - webgl
  - effect
workstream: W23
workstreamId: W23-9
dependsOn:
  - 01M69F029JAQXSKKGVNRDTMQ7C
order: 8
created: '2026-10-31T17:09:34.698Z'
updated: '2026-10-31T17:37:34.885Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.12.

The effect that gives the old-WMP feel, and the reason the GPU tier exists: per-pixel feedback at full-stage size.

- **WebGL2, `grow`, `needs.cover`.** Ping-pong feedback: each frame samples the previous one through a warp, zoom and rotation field. Bass drives zoom, mid drives rotation, treble drives warp turbulence, and the waveform is injected as a line on each frame.
- **Seeded from the cover.** At emergence 0 the feedback buffer *is* the wash, and the feedback strength scales up from zero with emergence, so the stage's own cover melts into the tunnel rather than one building out of black. When a track changes, the new cover is fed in through the cover crossfade rather than resetting the buffer.
- **Bounded energy:** feedback decays towards the palette's darker ramp steps, so the field neither saturates to white nor collapses to black over long playback.
- Colours: palette entries and cover samples only. Output multiplied by `stage.intensity`. Renders at the host's internal resolution, never assuming native.

**Done when:**
- at emergence 0 it is indistinguishable from the CSS wash;
- 30 minutes of continuous playback neither saturates nor dies out;
- it holds the `auto` budget on the Linux dev machine at 4K Zen;
- it passes the strobe-heavy track check without the flash guard having to clamp it continuously (the guard is a backstop, not the effect's normal operating mode).
