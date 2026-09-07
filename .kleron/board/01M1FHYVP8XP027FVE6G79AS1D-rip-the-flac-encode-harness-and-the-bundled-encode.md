---
taskId: 01M1FHYVP8XP027FVE6G79AS1D
title: 'Rip: the FLAC encode harness and the bundled encoder binary'
status: backlog
priority: medium
labels:
  - cdrip
  - encoding
  - packaging
  - licensing
workstream: W18
workstreamId: W18-3
dependsOn:
  - 01M1FHX2E9B7GSQRZHJ4MPFHX1
order: 17
created: '2026-09-01T22:38:10.632Z'
updated: '2026-09-01T22:38:10.632Z'
---
## Intent

Take raw PCM from W18-1 and produce a tagged FLAC file on disk. One codec, one encoder, one path —
the MVP narrowing to FLAC is what keeps this card an afternoon rather than a format matrix.

## Why the reference `flac` binary and not ffmpeg

ffmpeg is the obvious reflex and it is the wrong call for one codec. The reference encoder is
~200 KB per platform against ffmpeg's ~70 MB, it is **BSD-licensed** so there is no LGPL relinking
obligation to reason about at all, and it takes raw PCM on stdin natively. ffmpeg buys nothing here
except the formats this stream has explicitly deferred.

Bundled as a **subprocess, not a linked library**. That keeps the licensing question at mere
aggregation regardless of which encoder is bundled later, and it keeps the encoder's failure domain
separate from the native addon's — a crashing encoder loses one track, not the app.

The interface must be codec-agnostic even though only one codec is implemented, so that adding
Opus or MP3 later is a new implementation rather than a refactor of everything above it. When that
day comes ffmpeg replaces `flac` behind this interface and the licence analysis is redone then,
under a new card.

## Contract

`src/main/cdrip/encoder.ts`:

- `interface Encoder { readonly ext: string; encode(pcm: Readable, dest: string, signal: {
  aborted: boolean }): Promise<void> }`
- `createFlacEncoder(deps: { binaryPath: string; compressionLevel?: number }): Encoder`

Invocation is `flac --endian=little --sign=signed --channels=2 --bps=16 --sample-rate=44100
--compression-level-<n> -o <dest> -` with PCM streamed to stdin. **No intermediate WAV on disk** —
sectors go from the addon straight into the encoder's stdin. A 70-minute disc is ~740 MB as WAV and
writing it twice is pure waste.

Default compression level 5 (the encoder's own default: the knee of the ratio/time curve). Expose
it in settings only if an operator asks; do not build a slider on speculation.

## Failure handling

Non-zero exit, a stderr diagnostic, a broken pipe and a cancelled signal are four different
outcomes and must not collapse into one generic failure. On any of them **delete the partial output
file** before returning — a truncated `.flac` left in a watched root is worse than no file, because
W2's scanner will happily index it.

## Tagging

Tags are applied after encode via W16's `resolveCodecWriter` / `applyWritableTags` in
`library/writeback/writer.ts`. Do not hand tags to the encoder's `--tag` flags and do not open a
second tag-writing path: reusing `writer.ts` means ripped files inherit the field mapping that
`npm run probe:writeback-corpus` already gates, and FLAC/Vorbis-comment mapping stays defined in
exactly one place.

Note the ordering consequence for W18-5: encode, then tag, then rename into place. Tagging a file
that is already visible to the watcher would race.

## Packaging

`flac` binaries land under `resources/` per platform and are declared in `electron-builder.yml`.
Two things to get right:

- Resolve the path through `process.resourcesPath` in a packaged app and a repo-relative path in
  dev; wrap that in one function so no caller branches on it.
- Set the executable bit on the Linux binary at package time — it does not survive a naive copy,
  and the failure is a confusing `EACCES` at first rip.

Add the BSD licence text to the open-source credits modal (W14 built it) — a bundled binary is a
distributed dependency and belongs there.

## Files

- `src/main/cdrip/encoder.ts`
- `resources/bin/<platform>/flac[.exe]`
- `electron-builder.yml` — `extraResources` entry
- `src/renderer/panels/openSourceCredits.ts` — the FLAC entry

## Tests

- Encode a synthesised PCM buffer (a few seconds of tone) and assert the output decodes back to
  the same samples with `music-metadata` reporting the right duration, channels and sample rate.
- A cancelled encode leaves **no file behind**.
- Non-zero exit surfaces the encoder's stderr rather than a generic message.
- The binary-path resolver returns the right shape in both dev and packaged layouts.

## Out of scope

No second codec. No compression-level UI. No ReplayGain calculation at rip time — the existing
scan-time ReplayGain path picks the files up once they are indexed, and duplicating it here would
be a second implementation of a solved problem.
