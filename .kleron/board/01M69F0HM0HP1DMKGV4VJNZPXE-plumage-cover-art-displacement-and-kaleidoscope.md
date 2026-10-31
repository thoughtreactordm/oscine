---
taskId: 01M69F0HM0HP1DMKGV4VJNZPXE
title: Plumage — cover-art displacement and kaleidoscope
status: todo
priority: medium
labels:
  - D35.9
  - D35.11
  - D35.12
  - renderer
  - webgl
  - effect
workstream: W23
workstreamId: W23-10
dependsOn:
  - 01M69F029JAQXSKKGVNRDTMQ7C
order: 9
created: '2026-10-31T17:09:42.655Z'
updated: '2026-10-31T17:37:34.941Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.11, D35.12.

The headline cover effect: the stage's own cover starts to move.

- **WebGL2, `grow`, `needs.cover`.** It samples `cover.current.texture` (mixed with `previous` by `cover.mix`), object-cover fitted via `aspect`.
- **Displacement:** a smooth noise field whose amplitude follows the band energies, with low frequencies moving large regions and highs adding fine shimmer.
- **Kaleidoscope:** segment count and rotation eased from `level`, with `MIRRORED_REPEAT` making the folds seamless.
- **Chromatic split on onsets:** a brief RGB offset, enveloped by the flash guard's minimum attack and multiplied by `stage.intensity`. This is the part of the effect most likely to strobe on a bright cover, so check it specifically.
- **At emergence 0 it is exactly the wash** (blur, saturation and opacity included), with displacement, kaleidoscope and split all scaling up from zero.
- 640-px source: blur and displacement hide the upscale. It never shows the cover sharp at full size.
- A synthetic cover (no art) must still look intentional, not like a broken texture.

**Done when:** at emergence 0 it is indistinguishable from the CSS wash; track changes crossfade inside the effect; a strobe-heavy track on a high-contrast cover stays inside the guard; it holds the `auto` budget at 4K Zen.
