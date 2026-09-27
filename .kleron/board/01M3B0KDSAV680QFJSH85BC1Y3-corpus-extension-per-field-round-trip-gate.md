---
taskId: 01M3B0KDSAV680QFJSH85BC1Y3
title: Corpus extension — per-field round-trip gate
status: in-review
priority: medium
labels:
  - '1.1'
  - tag-writeback
  - gate
workstream: W16
workstreamId: W16-16
order: 1
created: '2026-09-25T00:49:16.073Z'
updated: '2026-09-25T21:39:59.932Z'
---
Design: `oscine-tag-writeback` → "Test corpus (W16-3)" and **Decision D** (a field enters the registry only when its check is green on all five codecs).

## Scope
- Extend `probe:writeback-corpus` / `probe:writeback-fixture` with one `written:<field>` check per registry field across `flac | mp3 | vorbis | opus | aac`: **set**, **clear**, and for `list` fields a **multi-value** case (two composers read back as two, in order).
- `written:album-artist` (W16-14) is additionally read back through `music-metadata`, since the scanner groups on `common.albumartist` — a frame taglib reads but music-metadata misses would re-shatter albums on rescan.
- `bool` (`isCompilation`) and `int` (`beatsPerMinute`, totals) checks assert type, not just string equality.
- Every existing `preserved:*` check stays green — in particular a flush that does not touch album artist must still leave it untouched.
- Output: a per-field × per-codec matrix in the report. Any red cell is a **triage card**, not a fix folded into the gate run (M-gate philosophy), and that field stays non-admitted in W16-15's registry.

## Acceptance
- Gate runs green on Linux and Windows from the same commit, or every red cell has a triage card and its field is marked non-admitted.
- Can proceed in parallel with W16-15; W16-17's flush of a field depends on that field's cell being green.

## Implementation notes (2026-09-25)
- Field table `scripts/lib/writeback-field-cases.mjs` (+ `.d.mts`) mirrors `TAG_FIELDS` with values to write; `tests/tooling/writebackFieldCases.test.ts` fails if the two drift (key, order, taglib prop, kind, read-only, value within registry bounds).
- **Isolation:** each set runs alone on a fresh copy of the corpus file. Each multi/clear runs alone on a copy of the *populated* file (all green fields written together, also checked as `written:fields:together`). A cell is green only if the target landed type-exact **and nothing else moved**: other registry fields, the grouped fields (title/artist/album artist/album/genres/year/track/disc) and the seeded custom frames. The first run wrote all fields at once and mis-attributed the mp3 COMM clobber; that is why the writes are isolated.
- Clear contract per kind (`CLEAR_VALUE`): text `undefined`, list `[]`, int `0`, bool `false`. W16-17's writer must use the same values.
- ReplayGain rows are `read:<field>`: seeded and read back (±0.005), never cleared.
- Album artist: seeded at synthesis (`seed:` / `preserved:` / `reader:preserved:album-artist` across the scalar write), then set/cleared exactly as `writer.ts` does, read via taglib and music-metadata.
- Corpus version 3. New `audio:untouched:after-field-writes` hash on the populated file.

## Results — linux/x64 (Windows run still owed)
533/536 checks green. Matrix: 32/35 rows green on all five codecs.
- ❌ `comment` × mp3 (set) — ID3v2 accessor overwrites a described COMM frame → **W16-19**
- ❌ `musicBrainzArtistId`, `musicBrainzReleaseArtistId` × aac (clear) — Apple setter `split`s `undefined` → **W16-20**

Registry: every field is now admitted except these three, which are wrapped in `held(...)` with a comment naming their triage card. The admission is based on Linux evidence only. Run `npm run probe:writeback-corpus` on Windows from the same commit, and hold any field whose row comes back red there.
