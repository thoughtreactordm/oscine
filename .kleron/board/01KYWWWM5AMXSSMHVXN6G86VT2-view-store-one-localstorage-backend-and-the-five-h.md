---
taskId: 01KYWWWM5AMXSSMHVXN6G86VT2
title: >-
  View store — one localStorage backend, and the five hand-rolled modules
  absorbed
status: in-progress
priority: high
labels: []
workstream: W8
workstreamId: W8-3
dependsOn:
  - 01KYWWVQQB80JQ6KK80HX96KYN
order: 1
created: '2026-07-31T20:12:13.864Z'
updated: '2026-08-01T03:43:13.622Z'
---
The renderer half of the split, and the card that pays for this workstream by deleting code.

Five modules independently hand-roll the same thing today — a `browserXyzStorage()` wrapper around `globalThis.localStorage` with its own guard, its own JSON `try`/`catch`, and its own field-by-field normalize-on-read:

| Module | Key |
|---|---|
| `playback/transportPreferences.ts` | `fermata.transport` |
| `shell/shellLayout.ts` | `fermata.shellLayout.v1` |
| `panels/playlistSession.ts` | `fermata.playlistTabs.v1` |
| `panels/groupingLayout.ts` (+ `stores/grouping.ts`) | `fermata.trackGrouping.v1` |
| `panels/columnLayout.ts` | column layout |

One backend replaces all five. Storage stays injected — that is the good part of the existing design and it is why these modules are testable without a DOM; keep it.

## Migration of existing values

Each absorbed key ships a one-time read of its legacy localStorage key, written into the registry-backed store and then the legacy key removed. **No operator-visible loss**: pane sizes, open playlist tabs, column widths and grouping state all survive the upgrade. A test per legacy key asserts this, with a fixture of the real stored shape.

Values that were previously normalized field-by-field on read now go through the descriptor's `validate`, which is where that logic belongs.

## Done when

- One `view`-scope store exists; the five `browserXyzStorage` wrappers and their duplicated normalize code are **deleted**, not merely unused.
- Legacy keys migrate on first run and are then cleaned up; a second run is a no-op.
- Debounced writes, so a pane drag does not write on every frame.
- `rg "localStorage" src/` returns hits in exactly one module.
- Existing tests for the absorbed modules still pass, adjusted only where they constructed a storage wrapper directly.
