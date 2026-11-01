---
taskId: 01M69EZ4X26HYEWBC126G2R70S
title: 'Wash and transitions — handoff, emergence, FLIP cluster move (2D tier)'
status: in-review
priority: medium
labels:
  - D35.4
  - D35.12
  - renderer
  - theme
workstream: W23
workstreamId: W23-5
dependsOn:
  - 01M69EYSQ430SQBYD9GP7TRQ2Z
order: 0
created: '2026-10-31T17:08:56.864Z'
updated: '2026-10-31T22:17:49.066Z'
---
Spec: wiki `oscine-visualizers` → D35.12, D35.4 (the FLIP move), D35.7 (pause settles to wash).

What makes on, off, pause and switching seamless: the visualizer draws the stage's blurred wash itself and every transition passes through it. This card does it on the 2D tier; W23-8 adds the matching GPU wash pass.

**One source of truth for the wash**
- Move the literal multipliers out of `.stage-wash-img`'s `calc()`s (blur × 1.6, `saturate(2.2)`, opacity = bleed × 1.1, `scale(1.25)`) into four typed custom properties on the stage: `--stage-wash-blur`, `--stage-wash-saturate`, `--stage-wash-opacity` and `--stage-wash-scale`, **registered with `@property`** (unregistered, their computed value is the unresolved `calc(…)` string).
- `.stage-wash-img` consumes them, and the host reads them on `onThemeChange`. The look of the stage must not change: compare before and after by screenshot.

**2D wash pass:** draw the cover into a small offscreen canvas with `ctx.filter` blur and saturate scaled to match, upscale with smoothing, and emit it at the wash opacity onto the transparent, premultiplied canvas. Rendered once per cover or theme change, then blitted per frame. No cover → no wash, matching the stage today.

**Handoff:** on enable, render the wash frame, and only once it's presented fade the CSS `<img>` out over 150 ms. On disable, the reverse after emergence reaches 0, then unmount and stop the loop. Only the CSS wash's `opacity` is ever animated, never its `filter`.

**Emergence:** the host eases `StageInputs.emergence`.
- `overlay` effects are composited over the wash, scaled by emergence, with `washUnder` (default 1) left under them at rest. Bars becomes a true overlay on the host-drawn wash.
- `grow` effects receive `stage.wash` and must equal it at emergence 0.

**Transitions:** every row of D35.12's table that applies to 2D: on, off, pause (after 3 s paused, settle to the wash and stop the loop on it, without moving the layout), resume, same-surface switch, track change and no cover. Durations are multiples of `--oscine-motion-duration`.

**FLIP cluster move:** measure both layouts, apply the inverse `transform`, and animate `transform`/`opacity` only, timed with the emergence. Never animate `--stage-art-max` or any layout property per frame.

**Dev flag:** `VITE_VISUALIZER_HOLD_EMERGENCE=<0..1>` freezes emergence for the W23-15 screenshot checks.

**Tests:** the emergence/transition state machine as a pure model (each event sequence in the table, including pause → switch → resume and off-during-on).

**Done when:** in the dev build, toggling on and off, pausing and switching between 2D effects show no visible cut on Linux, and the stage with the visualizer off is pixel-identical to before.
