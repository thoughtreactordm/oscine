---
taskId: 01M69F1DBWCCEF1Z42E1CHYZGN
title: Phase — X/Y Lissajous scope
status: todo
priority: low
labels:
  - D35.9
  - D35.10
  - renderer
  - effect
workstream: W23
workstreamId: W23-14
dependsOn:
  - 01M69F174SBVQFK74JYKJA2DK5
  - 01M69EYSQ430SQBYD9GP7TRQ2Z
order: 13
created: '2026-10-31T17:10:11.066Z'
updated: '2026-10-31T17:37:35.193Z'
---
Spec: wiki `oscine-visualizers` → D35.9, D35.10.

The one stereo effect, and the first consumer of the stereo tap.

- **2D, `overlay`, `needs.stereo`.** It plots left against right, rotated 45° so that mono content draws a vertical line and wide stereo opens out, with phosphor-style persistence (`dtSec`-driven fade).
- The host subscribes to the stereo tap only while Phase is the active effect, and unsubscribes on switch or dispose, so the lazy attach/detach in W23-13 actually happens. The host gains a `needs.stereo` path: the effect is unavailable when the engine has no `readStereoWaveform`.
- Colours come from palette entries only, and output is multiplied by `stage.intensity`.

**Tests:** the pure point-mapping function (a mono sine maps to a vertical line, an L-only signal to a diagonal, anti-phase to a horizontal line); the host subscribes exactly while Phase is active.

**Done when:** Phase runs on both decoded and R1-streamed tracks, switching away from it detaches the stereo analysers (verified in the dev build), and it is unavailable rather than broken when the engine lacks the method.
