---
taskId: 01M7EDB92X828EFVPMS3NBW1FZ
title: 'Writer Opus R128_* branch + W16-16 written: corpus rows, then unhold'
status: in-review
priority: medium
labels: []
workstream: W25
workstreamId: W25-5
dependsOn:
  - 01M7EDA8PT24R1QT0ZA9WRAXM3
  - 01M7EDAVDD2BF7FYSMWK7W4WAA
order: 30
created: '2026-11-15T01:32:31.195Z'
updated: '2026-11-16T20:32:39.808Z'
---
**Phase 2 — RG-5.** The write half of D37 **Decision E**, plus the corpus gate that unholds the fields. Depends on RG-2 (the shared Q7.8 conversion and the scanner read-back) and RG-4 (staging produces the rows that reach the writer).

**Writer Opus branch** in `writeback/writer.ts` for the four ReplayGain keys:
- write `R128_TRACK_GAIN = round((trackGainDb − 5) × 256)` and the album equivalent through the **raw-field path** W16-19/20 established (`PROPERTY_ACCESS`), **not** the portable property — node-taglib-sharp's `XiphComment` otherwise writes `REPLAYGAIN_*` for Opus, which other Opus players ignore or double-apply;
- **remove any `REPLAYGAIN_*` fields in the same write**;
- **drop peaks** (there is no R128 peak tag).

Resolve **OQ4**: how node-taglib-sharp formats peaks per tag type (ID3 `TXXX`, Apple freeform, Xiph). Gains are `toFixed(2) + " dB"` in `xiphComment.js:684`; peaks should be six decimals.

**Corpus gate (extends W16-16, `npm run probe:writeback-corpus`).** Each ReplayGain field moves from a `read:<field>` row to a `written:<field>` row: set on all five codecs, read back through music-metadata within **±0.005**. The Opus cells assert `R128_*` present, `REPLAYGAIN_*` absent, peak **not** written. A field is unheld (remove the `held()` wrapper from RG-3) **only when its whole row is green on Windows and Linux** — attach the Windows run.

**Blocked on R20 / OQ1:** must not land until the Opus header-output-gain question from RG-2 is confirmed against `rsgain` with a non-zero-output-gain fixture. A wrong answer means every written Opus gain is off by exactly the header gain.
