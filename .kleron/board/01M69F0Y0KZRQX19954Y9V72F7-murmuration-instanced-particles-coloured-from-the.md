---
taskId: 01M69F0Y0KZRQX19954Y9V72F7
title: Murmuration — instanced particles coloured from the cover
status: todo
priority: low
labels:
  - D35.9
  - D35.11
  - renderer
  - webgl
  - effect
workstream: W23
workstreamId: W23-12
dependsOn:
  - 01M69F029JAQXSKKGVNRDTMQ7C
order: 11
created: '2026-10-31T17:09:55.346Z'
updated: '2026-10-31T17:37:35.074Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.11 (swatches / texture sampling).

An abstract `overlay` effect that still carries the cover's colours.

- **WebGL2, `overlay`, `needs.cover`, `washUnder` at the default 1**, so the flock flies over the wash.
- A few thousand instanced particles advected through a curl-noise flow field. Particle state lives on the GPU (transform feedback or a state texture ping-pong; pick whichever is simpler with the W23-8 helpers), with no per-frame CPU particle loop.
- **Onsets scatter the flock** outward from a point picked by the dominant band; it re-forms as the onset envelope decays. `bass` sets the overall flow speed.
- **Colour:** each particle takes the colour of the cover pixel it was born over (sampled from a small mip or from the swatches), so the cover's hues come through without a palette extractor. Particles born after a track change take the new cover's colours, so the palette turns over gradually rather than snapping.
- Output is multiplied by `stage.intensity` and scaled by emergence (an `overlay` effect, so the host does the compositing).
- The particle count scales with the quality tier.

**Done when:** the flock visibly reacts to onsets without strobing; colours follow the cover across track changes; it holds the `auto` budget at 4K Zen on the Linux dev machine; `low` quality is smooth on an integrated GPU.
