---
taskId: 01M69F029JAQXSKKGVNRDTMQ7C
title: >-
  WebGL2 tier — probe, gl helpers, cover textures, GPU wash, context loss,
  budget
status: todo
priority: medium
labels:
  - D35.6
  - D35.11
  - D35.12
  - R16
  - renderer
  - webgl
workstream: W23
workstreamId: W23-8
dependsOn:
  - 01M69EZ4X26HYEWBC126G2R70S
order: 7
created: '2026-10-31T17:09:26.960Z'
updated: '2026-10-31T17:37:34.820Z'
---
Spec: wiki `oscine-visualizers` → D35.6, plus the GPU halves of D35.11 and D35.12, and R16.

The optional GPU tier, built so that it fails into 2D rather than into a broken stage. **Raw WebGL2, no dependency** (no three.js, regl or twgl).

- **Capability probe:** once per session, a throwaway context with `failIfMajorPerformanceCaveat: true`. If it fails (software rendering, SwiftShader), every `surface: 'webgl2'` effect is unavailable: left out of next/prev, the cycle and the palette, with a stored WebGL id falling back at runtime without being rewritten. No IPC, no `app.getGPUFeatureStatus()`.
- **`src/renderer/visualizer/gl/` helpers:**
  - program compile and link that surfaces the info log;
  - a full-screen triangle;
  - a ping-pong framebuffer pair;
  - the **cover upload helper** with D35.11's rules: `SRGB8_ALPHA8`, mipmaps with `LINEAR_MIPMAP_LINEAR`, `MIRRORED_REPEAT`, one `UNPACK_FLIP_Y` convention, and `aspect` passed as a uniform. This fills `CoverSlot.texture`, and textures are deleted when a slot is closed.
- **GPU wash pass:** matches the 2D one from W23-5 and the CSS wash. It downsamples through the mips to ⅛ size, runs a separable Gaussian with σ = `--stage-wash-blur` scaled (about 25 taps × 2 passes on a ~240×135 target), applies saturate using the Filter Effects spec matrix and emits at `--stage-wash-opacity`, premultiplied. Rendered once per cover or theme change, then blitted.
- **2D ↔ WebGL switching:** the canvas element is replaced at emergence 0. Both tiers draw the same wash, so the swap is invisible.
- **Compile failure** marks only that effect unavailable for the session and logs once.
- **Context loss:** `preventDefault()`, restore the CSS wash instantly, and grow the first 2D effect from it. Rebuild on `webglcontextrestored`, re-uploading from the host's retained bitmap. Two losses in a session mark the tier unavailable until restart.
- **Resolution budget and `interface.visualizerQuality`:**
  - `auto`: a ~2.1 MP internal target at 60 fps, backing off to `low` after a rolling frame-time average stays over budget for 2 s.
  - `low`: 1 MP at 30 fps.
  - `high`: native resolution at 60 fps.
  - Internal targets are upscaled to the canvas.
- **Flash guard sampling:** an 8×8 `readPixels` every few frames feeds W23-2's luminance monitor.

**Tests:** pure parts only: the quality/budget model (resolution caps by tier, the backoff hysteresis), the availability resolution (probe fails, compile fails, two context losses), the cover-fit UV maths.

**Done when:** a trivial `grow` test effect at emergence 0 is indistinguishable from the CSS wash on Linux; forcing `--disable-gpu` hides WebGL effects and leaves 2D working; a forced context loss (`WEBGL_lose_context`) recovers through the CSS wash without a cut.
