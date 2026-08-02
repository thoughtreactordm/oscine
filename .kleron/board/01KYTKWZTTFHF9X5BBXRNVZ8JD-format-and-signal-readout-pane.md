---
taskId: 01KYTKWZTTFHF9X5BBXRNVZ8JD
title: Format and signal readout pane
status: in-review
priority: medium
labels:
  - M5
  - phase-1
  - ui
workstream: W7
workstreamId: W7-3
dependsOn:
  - 01KYTKWGS08GKKM5P6HR53HFMK
order: 8
created: '2026-07-30T22:56:39.769Z'
updated: '2026-08-02T14:43:24.474Z'
---
## Scope

- Codec and container, bit depth, sample rate, bitrate with CBR/VBR, channel layout, duration.
- ReplayGain track and album values, and which mode is actually being applied right now.
- Whether **R1**'s `<audio>` streaming fallback took over for this track, and the decoded-size estimate against the configured budget.

## Acceptance

- Correct values for MP3, FLAC and OGG from the `probe:fixture` library, plus one high-resolution lossless file.
- The streaming-fallback state is visibly distinct — this is the one place a user can find out why a transition was hard.
- Nothing renders as "unknown" that `music-metadata` actually provides.
- No new IPC surface unless it starts in `src/shared/ipc.ts`; prefer riding the metadata the renderer already holds.

## Notes

Fermata's pitch is format-first and today nothing in the UI surfaces any of it. This is the cheapest card in the stream — almost pure UI over data already in hand — and the best demonstration of what the deck is for. Good first card after the shell.

---

## Done — `bb51292`

Three blocks: what the file is, what is being done to its loudness, how it
reached the speakers. `SignalPane.vue` over `signalReadout.ts`, which is the
whole of what the pane *claims* and carries the tests.

### The card's premise was half right

"Almost pure UI over data already in hand" held for codec, sample rate, bit
depth, channels, duration and all four ReplayGain values — those are columns on
`Track`. Two things were not in hand:

**Container, bitrate, CBR/VBR are in no column.** `metadata.ts` folds
`format.container` into `normaliseCodec` and drops `format.bitrate` and
`format.codecProfile` entirely. Chose on-demand re-parse over a migration:
`library.getTrackFormatDetail(trackId)` (starting in `src/shared/ipc.ts`, as the
card requires) reads one header in main and returns `TrackFormatDetail`. A
migration would have bought three columns that no query filters or sorts on,
NULL for every already-indexed track until a forced full rescan. The readout
wants one track at a time; re-parsing is milliseconds and is correct on an
existing library the moment the pane opens.

**R1's verdict was not reachable.** `GuardedAudioEngine` computed a full
`R1AdmissionDecision` and handed it to `console.info`. `AudioEngine` now exposes
it as `readonly admission` — added to the `AudioPath` mirror-guard exclusion
list, because it is the verdict *about* which path won and a path that could
read it would know whether it is the fallback. The controller mirrors it into a
ref on `statuschange` and `trackchange` (both needed: one covers the scheduler's
own advance, the other the first load from the UI). `normalizationPolicy` is now
exposed too, so the pane calls `resolveNormalization` with the same value the
scheduler was handed and cannot disagree with the audible gain.

### Two rules the readout keeps

- **A fact we do not have is not a row.** An MP3 has no bit depth; `Bit depth —`
  says "we failed to read it" about a field that does not exist. Pane height
  varies by format, which is the readout working.
- **Constancy is never inferred.** `bitrateMode` reads the encoder's profile
  string (`CBR`, `V0`–`V9`, `ABR`) and is `null` otherwise. The tempting test —
  header bitrate vs `size × 8 / duration` — makes a CBR MP3 with a large cover
  read as variable, because artwork and ID3 blocks count toward file size.
  Lossless is left unlabelled too: FLAC varies per frame by construction, and
  calling that VBR beside a V0 MP3 implies a choice the encoder never offered.

### Verification

Second instance on a scratch user-data dir against a real fixture library
(`probe:fixture` plus a 96 kHz/24-bit FLAC and a ReplayGain-tagged 320k CBR MP3),
format values compared against `ffprobe`:

| file | pane | ffprobe |
|---|---|---|
| `probe-mp3.mp3` | MPEG · MPEG 1 Layer 3 · 192 kbps CBR · 44.1 kHz · Stereo | mp3, 44100, 2, 192652 avg |
| `probe-flac.flac` | FLAC · lossless · 44.1 kHz · 16-bit | flac, 44100, 2, 16 |
| `probe-ogg.ogg` | Ogg · Vorbis I · 160 kbps · 44.1 kHz | vorbis, 44100, 2 |
| `probe-hires.flac` | FLAC · lossless · 848 kbps · **96 kHz · 24-bit** | flac, 96000, 2, 24 |
| `probe-rg.mp3` | 320 kbps CBR, track −7.14 dB, album −6.25 dB, peak 0.9440, File tags | 321110 avg |

All three ReplayGain modes exercised on the tagged file: `track` → "Track gain,
−7.14 dB applied" with the badge on the track row; `album` → the badge moves to
the album row; `off` → "Not normalized", both measurements still shown, no badge.
Untagged file → "No ReplayGain tags — the untagged fallback of +0.00 dB is
applied."

Streaming fallback forced with a 16 MiB decode cap:

> **Streaming** — Streaming: an estimated 22 MiB decoded is over the 16 MiB
> per-track cap. Gapless and crossfade need a decoded source, so this track
> joins its neighbours with a hard cut. · Decoded size 22 MiB · Per-track cap
> 16 MiB · Boundary **Hard**

Warning-coloured icon, chip and meter, distinct from the decoded state's primary
colour. One duplication found this way and fixed: a CBR MP3 printed `CBR` on the
codec row and again on the bitrate row.

### For the reviewer

`format.bitrate` is what the file *declares*, not what it averages. On a pure
sine `probe-ogg.ogg` the Vorbis header's nominal 160 kbps sits beside an actual
average of 24.7 kbps, because a sine compresses absurdly. Every tagger reports
the nominal and real music makes the two converge, so this is left as-is —
noting it in case a triage card is wanted.

### Files

New: `signalReadout.ts`, `SignalPane.vue`, `tests/renderer/panels/signalReadout.test.ts`
(20 cases, driven through the real `decideR1Admission` and `resolveNormalization`
rather than fixture decisions).
Contract: `shared/library.ts` (`TrackFormatDetail`, `BitrateMode`), `shared/ipc.ts`,
`preload`, `renderer/ipc.ts`, `library/{service,sqliteService,metadata}.ts`, `main/ipc`.
Audio: `AudioEngine.ts`, `AudioPath.ts`, `GuardedAudioEngine.ts`, `audio/index.ts`,
`scheduler.ts`, `controller.ts`.
Registry: one line in `tunedeck/panes.ts` — `Tunedeck.vue` unchanged, which is
what the W7-1 seam was for.

Gate green: lint, format, typecheck, 1662 tests.
