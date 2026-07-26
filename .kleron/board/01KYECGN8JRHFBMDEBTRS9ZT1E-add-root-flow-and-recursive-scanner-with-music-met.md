---
taskId: 01KYECGN8JRHFBMDEBTRS9ZT1E
title: Add-root flow and recursive scanner with music-metadata
status: todo
priority: high
labels:
  - M1
workstream: W2
workstreamId: W2-2
dependsOn:
  - 01KYECG6165EXS8YGVG63WFZ6S
  - 01KYECFMPA141ZPJM8F2X54BAS
effort: high
order: 5
created: '2026-07-26T04:56:42.514Z'
updated: '2026-07-26T04:56:42.514Z'
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
