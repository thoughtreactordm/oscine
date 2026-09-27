---
taskId: 01M2JVW46WSPGJ8Y04VQZSZJMW
title: 'EQ: undo/redo for the visual curve editor'
status: done
priority: low
labels:
  - eq
  - ui
  - renderer
  - undo
workstream: W19
workstreamId: W19-10
dependsOn:
  - 01M1FJXM0N7Q7RQV88PQ3CHV03
  - 01M1FJWETAJMAMQ5VE07A2J9QP
order: 13
created: '2026-09-15T15:44:51.931Z'
updated: '2026-09-27T00:20:50.475Z'
---
## Intent

Undo/redo over the equalizer's visual editor state, so a mis-dragged node is one Ctrl+Z away from
where it was. Requested by the operator: input fields already carry native undo, so this is about the
curve — drag a handle wrong, undo returns it.

## Why the existing setup makes this cheap

Every editor mutation funnels through one write: `eq.active = <EqualizerSpec>` (a settings-backed
`WritableComputedRef`). A spec is a small serialisable value, so history is a stack of specs and undo
is a plain assignment back to `active`, which already flows to persistence and the audio graph via the
settings watcher. No new engine path.

## Design (dragend-only, no pre-drag snapshot)

- `src/renderer/stores/equalizerHistory.ts` — a pure `createSpecHistory(initial)`: `past`/`future`
  stacks + a lagging `baseline`. `record(next)` pushes the old baseline if `next` differs
  (deduped via `sameSettingValue`, capped at `DEFAULT_HISTORY_LIMIT = 100`, a new edit forks the
  timeline); `undo`/`redo` return the spec to write; `reset` re-baselines. No Vue, no `@renderer` —
  unit-tested like `createClipLatch`.
- `createEqualizerState` wires it: a `flush: 'sync'` watch on `active` is the single recorder, so a
  drag frame, a table edit, a recalled preset and even an external assignment all record through one
  path. `beginInteractive`/`endInteractive` bracket a continuous gesture so its per-frame writes
  collapse to one step (the lagging baseline *is* the pre-drag state — no snapshot needed). `undo`/
  `redo`/`canUndo`/`canRedo` exposed; the Pinia store spreads them.
- `EqualizerCurve.vue` brackets the node drag (pointerdown → begin, pointerup/cancel → end).
- `EqualizerTool.vue` — undo/redo buttons in the top bar, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y while
  the pane is mounted, guarded to leave native undo to focused text fields. The preamp *slider* drag
  is bracketed too; the stepper, numeric field and band-table inputs commit discretely (one step each).

## Known edges (accepted for v1)

- Undo restores the curve but not the applied-preset selection, so after undoing a recall the selector
  can read "(modified)". Cosmetic; the curve and audio are correct.
- An external per-entity assignment write becomes an undoable entry. The W19-6 suspend rule means this
  is rare during editing.

## Tests

- `tests/renderer/stores/equalizerHistory.test.ts` — the pure stack: record/undo/redo, dedup,
  no-op-preserves-redo, fork-drops-redo, cap, reset.
- `tests/renderer/stores/equalizer.test.ts` — undo/redo through `createEqualizerState`: restore exact
  spec, a bracketed drag is one step, fork drops redo, empty-stack no-op, recall is undoable.

Full gate green (lint, format, typecheck, 4308 tests).

## Out of scope

No persistence of history across restarts (ephemeral). No coupling of preset selection into history.
No per-field text-input undo (native handles it).
