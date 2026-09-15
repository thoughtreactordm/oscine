---
taskId: 01M29NGK6PH2ZQPRQ8TDZB13YA
title: 'EQ: bundled oratory1990 device library'
status: in-review
priority: medium
labels:
  - eq
  - presets
  - autoeq
  - oratory1990
  - bundled-data
workstream: W19
workstreamId: W19-9
dependsOn:
  - 01M29NFQVNX80VSJHST1EE3KFE
  - 01M1FJYKECE08QTX8M1E7PSDA3
order: 1
created: '2026-09-12T02:00:32.725Z'
updated: '2026-09-15T22:02:37.921Z'
---
## Intent

A searchable, bundled library of headphone/IEM EQ profiles — oratory1990's measurements via the
AutoEq corpus — so an operator picks their model from a list and the pane loads its curve. Builds
directly on the text import (W19-8): each device is a `ParametricEQ.txt` the same parser already reads.

## Scope: oratory1990 only, bundled

One source, deliberately. oratory1990 is the reference set the community trusts, it is a manageable
few hundred devices, and one curated source keeps the picker legible and the licensing question
singular. Other sources (Crinacle, Rtings) are a later card if wanted.

**Bundled, not fetched.** The app is local-first — "the library is folders on disk." A device list
that needs the network to browse would be off-brand and would fail offline. The trade is bundle size
and staleness, handled below.

> Record the bundle-vs-fetch choice as a settled decision on the `oscine-W19` stream wiki page — a
> D-number with a revisit trigger (e.g. "revisit if the corpus outgrows a sensible bundle, or if a
> second source is wanted"), per the post-1.0 decisions convention.

## The data pipeline

- A build-time script (`scripts/`) pulls oratory1990's `ParametricEQ.txt` files from a **pinned**
  AutoEq commit, parses each with W19-8's `parseParametricEq` (in node/main), and emits one bundled
  asset — an index of `{ id, name, spec }` — shipped as a committed build resource like `build/`
  icons: reproducible, and refreshed by re-running the script and bumping the pinned commit. Nothing
  fetches at runtime.
- Size: a few hundred devices × ≤12 bands is small as JSON; ship the compact `spec` form, not raw
  text, and measure the added bundle weight.

## Licensing / attribution — decide before bundling

AutoEq's code is MIT; the measurements are oratory1990's. Redistribution has been customary but must
be **confirmed and attributed in-app** — a "measurements by oratory1990, via AutoEq" credit in the
picker and in the About/licenses surface. This is the gating decision, not the engineering; resolve
it first.

## Surface

- A searchable, virtualized device picker (reuse existing list patterns) reachable from the EQ preset
  menu ("Load device…").
- Selecting a device applies its spec to the live curve and offers to save it as a named preset
  (e.g. "Sennheiser HD 600 (oratory1990)"), so it lands in the same preset/id machinery W19-6 can
  then assign per-entity.

## Sequencing

- **W19-8** (the parser) — done, this card reuses it.
- **W19-5** (preamp) first: every profile ships a preamp, and the operator should see and adjust it,
  so this is best landed after the preamp control exists.

## Caveats inherited from W19-8

12-band truncation on long profiles; Web Audio's fixed-S=1 shelves ignore an APO shelf's Q. Note
them in the picker where relevant.

## Tests

- The build script produces a valid, parseable index from a fixtures set of profiles.
- Every bundled device round-trips through `parseEqualizerSpec` — no entry ships an invalid spec.
- Picker search/filter is a pure model, tested off the DOM like the other list models.
- Applying a device sets the live curve and the offered preset name; the band ids are fresh.

## Out of scope

No other measurement sources. No on-demand network fetch. No auto-selection from connected hardware.
No target-curve customization (Harman vs flat) — the profiles are pre-computed.
