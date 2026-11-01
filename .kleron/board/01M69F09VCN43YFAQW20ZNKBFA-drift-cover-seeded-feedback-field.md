---
taskId: 01M69F09VCN43YFAQW20ZNKBFA
title: Drift — cover-seeded feedback field
status: in-review
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
order: 0
created: '2026-10-31T17:09:34.698Z'
updated: '2026-11-01T04:13:56.743Z'
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

## Shipped (2026-11-01)

Branch `w23-9/drift` (2a6a683 model + tests, 5fe040a effect + registry), merged `--no-ff` into `1.2/integration` as 4eb8fa2. Not pushed.

- `effects/driftModel.ts` — pure per-frame params. Recurrence per pixel: `warped = F(warp(uv))` → `mix(warped, dark, decay)` → `mix(warped, ring, ringAlpha·mask)` → `F' = mix(wash, warped, keep)`. Every step is a convex mix, so the field is bounded by its inputs. Emergence is folded into each rate (`keep = exp(−dt·(0.35 + 4(1−e)/e))`, which is 0 at e = 0), so growth is frame-rate independent and the field is exactly the wash at 0. The wash trickles back in at full emergence, which is how a track change's cover crossfade melts in without resetting the buffer.
- `effects/drift.ts` — two passes: an update into the ping-pong, then a present into the default framebuffer as `mix(wash, field, intensity)`, so a flash-guard clamp falls back to the wash, not to black. RGBA8 with one-code-value triangular dither, so 8-bit feedback can't stall into ghosts. Dither is off at emergence 0.
- **Design choice:** the waveform is injected as a **closed ring** (the tapered reader, as in Whorl), not a straight line, so zoom and spin carry it out into a tunnel. The ring's colour is 55 % the sharp cover sampled under it and 45 % palette (accent → text-highlighted on the beat). The decay target is primary-900 → primary-950, darkest at the rim. The spin direction reverses smoothly every ~48 s.
- Registered after Updraft. This is the first shipped WebGL effect, so the capability probe now runs in production builds.

**Verified:**
- `drift.test.ts`: wash-exact at 0, reseed, frame-rate independence (30 vs 120 fps), audio mapping, intensity 0, ring fade on silence, colours keyed on the palette version, and a 30-minute radial simulation with the zoom warp included. In the last 5 minutes the area mean moves between 0.13 and 0.36 (ring colour 0.95, dark target 0.06), with no drift against minutes 1–6.
- Headless Electron GPU run (throwaway harness): emergence 0 against the wash, max diff 0/255; intensity 0, also 0/255; no GL errors; valid premultiplied output; mean brightness flat over 2 minutes.
- The full gate is green.

**Owed (operator, in-app):** a 30-minute real-playback look; the `auto` budget at 4K Zen; the strobe-heavy track against the flash guard; the e = 0 screenshot against the CSS wash with `VITE_VISUALIZER_HOLD_EMERGENCE=0`; tuning the constants by eye.
