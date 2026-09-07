---
taskId: 01M1FJXM0N7Q7RQV88PQ3CHV03
title: 'EQ: the Tools pane — draggable curve, band table, preset bar'
status: backlog
priority: medium
labels:
  - eq
  - ui
  - tools
  - renderer
  - a11y
workstream: W19
workstreamId: W19-4
dependsOn:
  - 01M1FJVCQN5B4BZKETP8H0DDQC
  - 01M1FJWETAJMAMQ5VE07A2J9QP
order: 28
created: '2026-09-01T22:54:58.581Z'
updated: '2026-09-01T22:54:58.581Z'
---
## Intent

The operator-facing half: the third entry in the Tools rail, and the surface where bands are added,
dragged, typed and saved. This is the card the feature is judged on.

## The rail seam

`src/renderer/stores/tools.ts` states the contract outright — adding a tool is an entry in `TOOLS`
and a branch in `ToolsView`:

```ts
export const EQUALIZER_TOOL = 'equalizer'

export const TOOLS: readonly ToolDescriptor[] = [
  { id: TAG_WRITEBACK_TOOL, label: 'Tag write-back', icon: 'i-tabler-file-pencil' },
  { id: EQUALIZER_TOOL, label: 'Equalizer', icon: 'i-tabler-adjustments' }
]
```

Nothing else about the Tools tab changes. If it needs more than those two edits, fix the seam rather
than working around it.

**Not a settings custom control.** `customControls.ts` keeps a deliberate two-entry register and its
comment says why: "a dozen would mean the generated surface had quietly stopped being generated."
The EQ is a whole surface with its own interaction model, not a control for one key. Tools is where
it belongs. The Audio settings category gets a plain line pointing at it, nothing more.

## The curve, in SVG

SVG, not canvas, and the reason is the theming invariant: `stroke="var(--ui-primary)"` works
directly, where canvas forces either a hardcoded colour in a component or `getComputedStyle`
plumbing re-run on every theme swap. M5's exit criterion is that swapping a theme touches zero
component code, and a canvas EQ would be the exception.

- Log frequency axis, 20 Hz – 20 kHz, with decade gridlines labelled. Use `logFrequencyAt` /
  `fractionForFrequency` from W19-2 — the pane must not carry its own copy of the mapping, or
  hit-testing and drawing will drift apart.
- Linear dB axis, ±12 default with a ±24 toggle for the operator who is actually cutting a room
  mode.
- One translucent filled `<path>` per band plus one composite stroke, all from `responseCurveDb`.
  Redraw on `requestAnimationFrame`, not per pointer event — a drag fires far faster than the
  display refreshes and the curve is ~256 points.
- `<circle>` handles, sized for a real pointer target rather than for the screenshot.

## Interaction

- **Drag a handle** — x sets frequency, y sets gain. Clamp at the axis edges rather than letting a
  handle leave the plot.
- **Wheel or shift-drag on a handle** — Q. Show the value while it changes; Q is the parameter
  operators understand least and an unlabelled invisible change is why.
- **Double-click empty space** — add a peaking band at that point, up to `EQUALIZER_BAND_LIMIT`;
  past the limit, say so rather than silently ignoring the click.
- **Handle context menu** — filter type, reset, remove.
- **Alt-click a handle** — toggle that band's `enabled`, drawn as a dimmed curve. Per-band bypass is
  how an operator works out which band is doing the damage.

## The band table is not optional

Underneath the plot, one row per band: index, type select, frequency, gain, Q, enabled, remove. It
carries three things the plot cannot:

- **Precision.** "3.2 kHz, −4.5 dB, Q 2.1" is not reachable by dragging, and it is what an operator
  transcribing a measurement needs.
- **Keyboard access.** A drag-only surface is unusable without a pointer. The table's inputs are the
  accessible path, and the handles get `tabindex` with arrow-key nudging (arrows = frequency/gain,
  shift-arrows = fine, and announce values through `aria-valuetext`) so the plot is not a dead zone
  for keyboard users.
- **Filter type**, which has no sensible gesture.

Both directions bind to the same store state, so a drag updates the numbers live and typing moves
the handle.

## Preset bar

Across the top: a preset select, Save, Save as…, Rename, Delete, and a Reset-to-flat. Show
"Bass boost (modified)" from the store's `dirty` flag — an operator who has dragged a handle after
recalling a preset needs to know the preset no longer describes what they are hearing.

The master enable toggle sits here too, and it is the A/B compare: W19-1 makes it a click-free
15 ms ramp, so it can be hit repeatedly while listening, which is exactly what it is for.

## Theming

CSS custom properties from `src/renderer/theme/` only, including for the curve fill, gridlines and
the disabled-band state. If the right token does not exist, add it to the token layer rather than
reaching for a hex value in a component.

## Files

- `src/renderer/stores/tools.ts` — the rail entry
- `src/renderer/views/ToolsView.vue` — the branch
- `src/renderer/panels/tools/EqualizerTool.vue` — layout, preset bar
- `src/renderer/panels/tools/EqualizerCurve.vue` — the SVG plot and its pointer handling
- `src/renderer/panels/tools/EqualizerBandTable.vue`
- `src/renderer/panels/tools/equalizerModel.ts` — pointer-to-parameter mapping, hit-testing,
  add/remove logic, mirroring how `tagWritebackModel.ts` keeps the logic out of the component and
  under test

## Tests

`tests/renderer/`, against a mocked IPC surface, with the geometry logic tested through
`equalizerModel.ts` rather than through the DOM:

- Pointer-to-parameter mapping round-trips against `fractionForFrequency`, including at both axis
  extremes.
- Dragging past an edge clamps instead of escaping the plot.
- Double-click adds a band at the clicked frequency; at the limit it adds nothing and surfaces the
  reason.
- Removing a band leaves the others' ids intact (W19-3 depends on ids being stable).
- Typing in the table moves the handle and vice versa, with no feedback loop — assert the store is
  written once per change.
- Redraws are rAF-batched: a burst of synthetic pointer moves produces one curve recompute, not
  twenty.
- Recall marks not-dirty; a subsequent drag marks dirty; Save clears it.
- The enable toggle writes `audio.eq.enabled` and nothing else.
- Keyboard: a focused handle responds to arrows and exposes `aria-valuetext`.
- Theme swap changes the rendered colours with no component change — the M5 criterion, asserted.

## Out of scope

No spectrum-analyser overlay behind the curve; the existing analyser is time-domain and a spectrum
tap is separate work. No preamp control or clip indicator — W19-5. No per-entity assignment UI —
W19-6. No preset import/export. No drawing of phase.
