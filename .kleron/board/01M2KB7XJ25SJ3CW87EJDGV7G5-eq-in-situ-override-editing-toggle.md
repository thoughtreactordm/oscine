---
taskId: 01M2KB7XJ25SJ3CW87EJDGV7G5
title: 'EQ: in-situ override editing toggle'
status: in-review
priority: low
labels:
  - eq
  - ui
  - renderer
  - override
workstream: W19
workstreamId: W19-11
dependsOn:
  - 01M1FJZGK6EKG2HRQN94MPQK0M
  - 01M2JVW46WSPGJ8Y04VQZSZJMW
order: 0
created: '2026-09-15T20:13:26.977Z'
updated: '2026-09-15T21:22:27.587Z'
---
## Intent

A hard toggle that lets the operator edit a track's per-entity EQ **override** in situ, as it plays,
without touching the global curve. Requested by the operator as the "meet in the middle" between the
pure derived-override model (W19-6, post-refactor) and the earlier in-place editing: no automatic
swapping, but an explicit mode where the visual editor targets the override so edits can be heard,
saved to the preset, and the mode flipped back off.

## Design (the editor target switches; the override stays derived)

Today `eq.active` — read/written by the curve, band table, preamp, undo/redo, save-to-preset and the
preset selector — is hardwired to the global `audio.eq.active`. This feature makes `eq.active` a
**switching writable computed**:

- `editingOverride && eqOverride !== null` → reads/writes the **override ref** (the same
  `Ref<EqualizerSpec | null>` the assignment binding pushes into, injected into `createEqualizerState`).
- otherwise → reads/writes the **global**, exactly as today.

The global keeps its single-writer invariant for its own edits; override edits land in the derived ref
and **never write `audio.eq.active`**. `bindAudioPreferences` still plays `override ?? global`, so
nothing about the "no swapping / override never mutates global" model changes — the editor just points
at the override while the mode is on. Every consumer already goes through `eq.active`, so the curve,
table, preamp, save and undo follow the switch with no per-widget change.

## Behaviors

- **Toggle ON, track has an override:** editor shows/edits that override live (heard), selector shows
  its preset, "Save" writes the curve back to the preset (the binding re-derives an equal push).
- **Toggle ON, no override:** target is the global, so editing/preset-switching behaves exactly like
  toggle-off. The toggle is a persistent *mode* that follows tracks — assigned track → edits its
  override, unassigned track → edits global.
- **Toggle OFF:** current base functionality, untouched.

Undo history and the "(modified)" selector **re-derive on a context switch** (flipping the mode, or a
track change that pushes a new override) rather than logging it as an edit, so undo stays within the
curve actually being edited and never steps across the switch. This also retires the W19-10 "external
assignment becomes an undoable entry" edge.

## Assumptions (operator-confirmed)

- Preset dropdown in override mode = live-preview / Save overwrites the shown preset. Re-*assigning* an
  entity stays the separate W19-6 assignment menu.
- The toggle is ephemeral — resets to off on relaunch.
- Unsaved live override edits are discarded when the track changes.

## UI

A switch in the EQ pane top bar. A "Editing this track's override" badge when actively on an override;
a muted "no override — editing global" hint otherwise.

## Files (planned)

- `src/renderer/stores/equalizerState.ts` — inject `eqOverride`, add `editingOverride`, make `active`
  the switching target, re-derive history + selection on context switch.
- `src/renderer/stores/equalizer.ts` — pass the playback store's `eqOverride` ref in.
- `src/renderer/stores/playback.ts` — expose `eqOverride`.
- `src/renderer/panels/tools/EqualizerTool.vue` — the toggle + state badge.
- Tests: `tests/renderer/stores/equalizer.test.ts` — override-target editing, save-to-preset, context
  switch resets history + re-derives selection, no-override falls through to global.
