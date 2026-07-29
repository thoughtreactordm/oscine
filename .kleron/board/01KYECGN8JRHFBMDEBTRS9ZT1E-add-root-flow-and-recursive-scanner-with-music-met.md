---
taskId: 01KYECGN8JRHFBMDEBTRS9ZT1E
title: Add-root flow and recursive scanner with music-metadata
status: in-review
priority: high
labels:
  - M1
workstream: W2
workstreamId: W2-2
dependsOn:
  - 01KYECG6165EXS8YGVG63WFZ6S
  - 01KYECFMPA141ZPJM8F2X54BAS
effort: high
order: 0
created: '2026-07-26T04:56:42.514Z'
updated: '2026-07-29T04:22:38.470Z'
---
Turn a folder on disk into rows in the database. The first genuinely useful thing Fermata does.

## Scope

- `library.addRoot` opens a native folder picker in main, inserts a `roots` row, and kicks off a scan.
- Recursive directory walk filtered to supported extensions: `.mp3`, `.flac`, `.ogg`, `.opus`, `.m4a`, `.wav`. Skip hidden and system directories.
- Parse each file with `music-metadata`: title, artist, album, album artist, track and disc number, year, duration, codec, sample rate, channels, bit depth, and any existing `REPLAYGAIN_*` tags. Store ReplayGain values with `rg_source = 'tag'` — W3 reads these at M2 and computing them is expensive, so capture them now even though nothing uses them yet.
- Upsert `artists` and `albums`, resolving foreign keys. Album identity is `(title, album_artist_id)` per the schema — fall back to track artist when album artist is absent, or compilations shatter into one album per track.
- Insert `tracks` with `rel_path` relative to the root and `mtime` recorded for later incremental rescan.
- Populate `tracks_fts` alongside. M1 does not search, but backfilling an FTS index later is a migration nobody enjoys.
- Report progress back to the renderer over IPC — files seen, files indexed, current path.
- Scan off the main thread or in chunks that yield. A synchronous walk over a large library freezes the window and reads as a hang.

## Explicitly not in scope

No watcher (M3), no incremental rescan (M3), no artwork extraction (M3). Add-root and full scan only.

## Acceptance

- Adding a real mixed-format folder produces correct rows, verified by direct database inspection.
- Files that fail to parse are logged and skipped, never aborting the scan. One corrupt file in a large library must not cost the whole scan.
- Re-adding the same root is rejected cleanly rather than duplicating rows.
- The window stays responsive throughout.

## Outcome

Landed across five commits (`7b9ee3d`..`968cdd4`). 142 tests pass; `typecheck` and
`build` clean. New modules under `src/main/library/`: `walk.ts` (traversal),
`metadata.ts` (the `music-metadata` adapter), `store.ts` (every SQL statement),
`scanner.ts` (batching, progress, failure handling) and `sqliteService.ts`.

Verified against a **real mixed-format corpus** built with ffmpeg from the FLACs in
`~/Music` — one file each of flac / mp3 / ogg / opus / m4a / wav, real tags, plus a
hidden file, a non-audio sibling and a truncated FLAC. Inspected directly in SQLite:
all six codecs normalised correctly, tags and audio properties (96kHz/24-bit through
to lossy) correct, ReplayGain read from genuine Vorbis comments as `-7.5 dB` /
`0.944` with `rg_source = 'tag'`, hidden and non-audio files skipped, and a re-scan
left `tracks`/`albums`/`artists`/`tracks_fts` counts unmoved.

## Corrections and decisions worth knowing about

- **`music-metadata` v11 is pure ESM, and main is CommonJS.** Left external it
  would emit a `require()` that fails at runtime — in the packaged build, on the
  first scan. It is excluded from `externalizeDepsPlugin` so Rollup bundles it;
  safe because it has no native addon, unlike better-sqlite3. Verified in the
  built artifact: the emitted lazy parser chunks are CJS, the dynamic imports
  became `require()`, and no `import.meta` survives. The built app boots under
  Electron cleanly.
- **`music-metadata` does not throw on rubbish.** Handed a renamed text file, or a
  truncated download whose magic bytes are intact, it resolves with *every field
  empty* rather than rejecting. So a `try`/`catch` around the parser only catches
  I/O failures, and the card's "files that fail to parse are logged and skipped"
  is only half implemented without treating emptiness as the signal. The scanner
  skips anything reporting neither duration nor codec. Both behaviours are pinned
  by tests so a future parser upgrade that starts throwing is visible.
- **Album identity needs `IS`, not `=`.** SQLite treats every NULL as distinct, so
  `UNIQUE(title, album_artist_id)` does not constrain rows whose album artist is
  unknown. An equality lookup misses the existing row and the album shatters into
  one row per track — precisely the failure the card warns about, arriving by a
  different route than the missing album-artist fallback. Both are fixed and both
  are tested.
- **Contentless FTS5 cannot delete by rowid.** The `'delete'` command must be
  handed the exact values that were indexed or the index is left corrupt. They are
  read back from `tracks` rather than remembered, which is what makes re-scanning
  an already-indexed root idempotent instead of doubling every search hit. Schema
  v1 predates `contentless_delete=1`; adding it would need a migration and is not
  worth one yet.
- **Duplicate-root rejection needed more than `UNIQUE(roots.path)`.** That
  constraint only catches a byte-identical string — it misses case differences and
  trailing separators on Windows, and misses nesting entirely. `relateRoots` in
  `db/paths.ts` classifies same / inside / contains, and all three are refused with
  `conflict`. Nested roots are outside the card's literal wording but produce
  exactly the duplicate rows it exists to prevent.
- **WAVE_FORMAT_EXTENSIBLE.** Found only by scanning a real 24-bit/96k WAV: the
  parser reports `non-pcm (65534)`, which is a wrapper rather than a codec, and is
  how essentially every hi-res or multichannel WAV is written. It now normalises to
  `pcm` instead of showing the user a codec that reads like an error.
- **`addRoot` does not await its scan.** A real library takes minutes and the
  renderer is blocked on the call. `scanRoot` returns the in-flight promise rather
  than starting a second scan, which both makes the background scan awaitable and
  stops two scans racing the same rows.
- **Symlinks are followed, with a real-path cycle guard.** Refusing them would miss
  music on a normal Linux layout; following them without the guard turns a
  self-referential link into an unbounded scan, which presents as a hang.
- **Re-scan preserves `play_count`, `last_played_at` and `rating`.** They are user
  data, not file data, and the upsert's SET list deliberately omits them. Tested.
- **`title` falls back to the filename stem** when a file carries no title tag,
  which is what lets `Track.title` be non-nullable across IPC. Corrections still
  belong in `track_overrides` (D7).

## Not verified here

- **The window-responsiveness criterion was not observed by eye.** The mechanism is
  in place and tested structurally — writes are batched at 128 rows with an explicit
  yield between batches, and a test crosses that boundary — but nobody has watched
  the UI during a scan of a large library. Worth a minute at M1 exit (W2-5).
- **The native folder picker was not clicked.** Everything either side of it is
  tested, including the full add-root flow with an injected picker, and the app was
  confirmed to boot. The dialog itself needs a human.
- **Nothing was pushed: this repo has no git remote.** Commits are local on `main`.

## Left for later, deliberately

`rg_source` is overwritten on re-scan, so a rescan can replace an M2-`computed`
value with the file's absent tags. Flagged in a comment at the upsert. M2 owns
rescan-versus-computed-gain and should not have that policy guessed for it now.
