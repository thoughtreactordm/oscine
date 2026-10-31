---
taskId: 01M69F0QS2ANXPMR8WZ028R0JR
title: Rainfall and Groove — ripple and radial slit-scan over the cover
status: todo
priority: low
labels:
  - D35.9
  - D35.11
  - D35.12
  - renderer
  - webgl
  - effect
workstream: W23
workstreamId: W23-11
dependsOn:
  - 01M69F029JAQXSKKGVNRDTMQ7C
order: 10
created: '2026-10-31T17:09:48.961Z'
updated: '2026-10-31T17:37:34.993Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.11, D35.12.

Two more `grow` cover effects, both WebGL2 with `needs.cover`. They share a card because each is mostly one shader on top of W23-8's helpers.

**Rainfall:** a height-field ripple simulation on a ping-pong pair at the internal resolution. The cover is refracted through the surface normal. Each onset drops a ring: its size comes from the onset strength, and its position comes from the dominant band (low bands near the bottom, highs near the top, with jitter). Damping makes ripples die out over about 2 s, and is `dtSec`-correct. At emergence 0 the surface is flat and the output is the wash; ring amplitude scales with emergence.

**Groove:** a radial slit-scan. The cover is smeared tangentially around its centre like a record turning under a light, with smear length from `level` and angular velocity from `bass`. At emergence 0 the smear length is zero and the output is the wash.

Both effects:
- colours come only from the palette and the cover;
- output is multiplied by `stage.intensity`;
- a synthetic cover still reads as intentional.

**Done when:** each one, held at emergence 0, is indistinguishable from the CSS wash; both hold the `auto` budget at 4K Zen; both pass the strobe-heavy track check.
