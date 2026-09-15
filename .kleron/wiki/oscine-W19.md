---
title: Oscine — Built-in EQ
created: '2026-09-15T21:51:56.187Z'
updated: '2026-09-15T21:51:56.187Z'
---
Design authority for **W19 — Built-in EQ**. The stream owns the **D30** block; its
anchor decision **D30 — the EQ belongs to the AudioContext, not the engine and not
the track** is recorded in the workstream description (`.kleron/workstreams.json`)
and not restated here. This page records the follow-on decisions that D30 did not
settle, extending the block as `D30.n`. Read `[[fermata-design]]` for the invariants
and the frozen D1–D20; per the post-1.0 convention these stream decisions live here,
not there.

## What this is

The visual parametric EQ shipped across W19-1…W19-11: a Tools-tab pane over a fixed
pool of biquads on each live `AudioContext`, with named presets, per-entity
assignment (W19-6), preamp/auto-gain/clip headroom (R11, W19-5), undo/redo (W19-10),
in-situ override editing (W19-11), and text import of AutoEq / Equalizer APO
`ParametricEQ.txt` profiles (W19-8). W19-9 builds a **bundled device library** on top
of that import — the decisions below are its two settled questions.

## D30.1 — The device EQ library is bundled, not fetched

**The oratory1990 corpus ships in the app as a committed, generated asset; nothing
fetches device profiles at runtime.**

Oscine is local-first — "the library is folders on disk." A device picker that needed
the network to browse would be off-brand and would fail offline, exactly when someone
on a plane wants to dial in their headphones. So the corpus is pulled once at build
time by `scripts/build-device-eq-library.ts` from a **pinned** AutoEq commit, parsed
with W19-8's real `parseParametricEq`, and emitted as
`src/shared/audio/deviceEqLibrary.generated.ts` — reproducible and refreshed by
re-running `npm run eq:devices` and bumping the pin, the same discipline `build/`
icons and `src/shared/theme/palettes.ts` already follow.

**Scope is oratory1990 only, deliberately.** It is the reference set the community
trusts, a manageable few hundred devices (736 at the pinned commit), and one curated
source keeps the picker legible and the licensing question singular.

**The weight is paid lazily.** The generated asset is ~1.3 MB of source (~82 KB
gzipped); the picker component and its corpus are a `defineAsyncComponent` dynamic
import, so they split into their own renderer chunk and load only when the operator
first opens "Load device…" — the pane's initial bundle never carries them. Every
bundled spec is validated at two points: `tsc` checks the whole array against
`EqualizerSpec` at build, and a test round-trips every profile through
`parseEqualizerSpec`.

*Rejected*:
a. **Fetch on demand from AutoEq / a hosted index.** Breaks offline, adds a network
   failure mode to a local feature, and makes the picker's contents non-reproducible.
b. **Bundle raw `ParametricEQ.txt` and parse at runtime.** Ships more bytes and
   defers parse cost and failure to the operator; the compact parsed spec is smaller
   and validated at build.
c. **Multiple sources (Crinacle, Rtings) now.** Multiplies the licensing question and
   clutters the picker with duplicate, differently-targeted measurements.

*Accepted cost*: bundle weight and staleness. Staleness is a re-run away; weight is
lazy-loaded and gzips to ~82 KB.

*Revisit when*: the corpus outgrows a sensible bundle (a lazy chunk in the low
megabytes stops being reasonable), or a second measurement source is genuinely
wanted — at which point on-demand fetch or a downloadable pack is worth reopening.

## D30.2 — Redistribute AutoEq's profiles under MIT, credited in-app

**The bundled `ParametricEQ.txt` profiles are redistributed under AutoEq's MIT
licence, with the copyright and permission notice preserved and oratory1990 credited
where the data appears.**

AutoEq is MIT (Copyright (c) 2018-2022 Jaakko Pasanen). We treat the parametric
profiles as covered by that licence and implement to its terms: the notice travels
with the generated asset (a header comment and the `DEVICE_EQ_SOURCE` constant), the
picker shows "Measurements by oratory1990, via AutoEq (MIT)", and an entry lands in
the Open Source credits surface (`openSourceCredits.ts`). This was the gating
decision, resolved with the operator before any code was written.

*Rejected*:
a. **Bundle without attribution.** Fails MIT's notice requirement and drops a credit
   the measurements deserve.
b. **Hold the feature pending bespoke redistribution permission.** The MIT terms are
   the permission; the licence is what makes redistribution customary and lawful.

*Revisit when*: AutoEq relicenses, or a bundled source is added whose measurements
carry different terms — attribution and the licence entry are then re-read per source.

## Does NOT

- Reopen **D30** — the library is playback-time data feeding the existing AudioContext
  chain; it adds no DSP stage and touches no source file (D7 stands).
- Auto-select a profile from connected hardware, or customise target curves (Harman
  vs flat) — the profiles are pre-computed. Out of scope, not deferred.
