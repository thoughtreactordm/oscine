---
taskId: 01M7EDA8PT24R1QT0ZA9WRAXM3
title: Opus R128_* read in the scanner + shared Q7.8 conversion
status: in-review
priority: medium
labels: []
workstream: W25
workstreamId: W25-2
order: 1
created: '2026-11-15T01:31:58.041Z'
updated: '2026-11-16T20:09:00.150Z'
---
**Phase 2 — RG-2.** Independent of the rest of Phase 2; lands first. Implements the read half of D37 **Decision E (Opus writes `R128_*`, never `REPLAYGAIN_*`)**.

RFC 7845 §5.2.1 defines `R128_TRACK_GAIN` / `R128_ALBUM_GAIN` for Opus: a signed Q7.8 integer (1/256 dB) relative to −23 LUFS, applied on top of the header output gain. There is no peak tag.

**Scope:**
- **Shared Q7.8 conversion** — a pure function in `src/shared` with its own tests: `gainDb = value / 256 + 5` and the inverse `round((gainDb − 5) × 256)`, clamped at ±128 dB, round-tripping.
- **Scanner read** — `metadata.ts` reads `R128_*` from the native Vorbis comments and converts to dB. music-metadata does **not** map `R128_*` (verified: no R128 handling in `node_modules/music-metadata/lib`), so without this every Opus file `rsgain`/`opusenc` tagged is re-measured and our own future writes never read back as `'tag'`.

**Tests:** the Q7.8 conversion round-trips with clamping; the scanner reads `R128_*` on Opus and ignores it on other codecs.

**Verify before relying on the written values (R20, OQ1):** does the Opus decode path (worker analyzer and playback) apply the header output gain? If our decode ignores it, every written Opus gain is off by exactly that header gain. The write side (RG-5) must not land until this is confirmed with a fixture that has a non-zero output gain, measured, written, and checked against `rsgain`. This card only reads; flag the finding for RG-5.
