---
taskId: 01M29NFQVNX80VSJHST1EE3KFE
title: 'EQ: import parametric EQ text (AutoEq / Equalizer APO)'
status: done
priority: medium
labels:
  - eq
  - import
  - presets
  - shared
workstream: W19
workstreamId: W19-8
dependsOn:
  - 01M1FJWETAJMAMQ5VE07A2J9QP
  - 01M1FJXM0N7Q7RQV88PQ3CHV03
order: 12
created: '2026-09-12T02:00:04.724Z'
updated: '2026-09-27T00:20:50.453Z'
---
## Intent

Import a parametric EQ text profile — the Equalizer APO / AutoEq `ParametricEQ.txt` de-facto
standard — into the live curve. This is the on-ramp for the whole AutoEq / oratory1990 corpus
without bundling any of it: the operator downloads or pastes a device's profile and the pane loads it.

## Why it is nearly free

The format maps almost 1:1 onto `EqualizerSpec` — a preamp plus typed biquad bands (PK → peaking,
LSC/LS → lowshelf, HSC/HS → highshelf, LP/HP → pass, NO → notch). So this is a text transform feeding
the existing spec, store and preset machinery, not a new audio path.

## What shipped

- `src/shared/audio/parametricEq.ts` — pure `parseParametricEq(text) → { spec, filtersRead,
  warnings } | null`, beside the settings validators (the bundled device library, W19-9, parses the
  same files in main). Clamps to the node's ranges, generates fresh band ids, and reports rather than
  swallows: truncation past the 12-band pool, unsupported filter tokens (AP/BP/slope-stepped
  shelves), unreadable lines.
- `EqualizerTool.vue` — an "Import text…" item in the preset menu opens a paste modal; a successful
  import applies to the live curve and toasts the filter count plus any warnings, noting when the
  master is off so nothing is silently inaudible.

## Caveats (surfaced, not hidden)

- The fixed 12-band pool truncates longer profiles (most oratory1990 profiles are ≤10 filters).
- Web Audio shelves fix S=1 and ignore Q, so an APO shelf's Q is stored but the heard shelf is close,
  not identical — a Web Audio limitation, not ours.
- The imported preamp takes effect immediately (the router applies `preampDb`) but has no slider
  until W19-5.

## Tests

`tests/shared/parametricEq.test.ts` — a realistic oratory1990-style profile, ON/OFF, optional
gain/Q, unsupported-type skip, range clamping, band-limit truncation, comment lines, and null for
non-profile text.

## Out of scope

No file picker (paste only) — a bundled device browser is W19-9. No GraphicEQ (fixed-band) import.
No export.
