---
taskId: 01M1FGAS6272V4J1Z8GDYXNGKZ
title: 'Lyrics: local resolution — sidecar .lrc and embedded tags'
status: backlog
priority: medium
labels:
  - lyrics
  - main
  - metadata
workstream: W17
workstreamId: W17-2
dependsOn:
  - 01M1FGA0QA7ESY1H2H6BR18ASW
order: 11
created: '2026-09-01T22:09:44.129Z'
updated: '2026-09-01T22:09:44.129Z'
---
## Intent

Tiers 1 and 2 of the resolution chain, entirely local: a sidecar `.lrc` beside the audio file, and
lyrics embedded in the file's own tags. Plus the `lyrics.get` IPC channel and the resolver that
orders the tiers. **No network in this card** — the resolver is written with a tier-3 seam that
W17-4 fills, so the feature is complete and useful with `network.externalLookups` off.

## Tier order and why

1. **Sidecar `.lrc`**, same basename as the audio file. First because the operator put it there
   deliberately, so it must beat anything the app found on its own.
2. **Embedded tags.** `music-metadata` already parses these on every scan and `toTrackTags`
   (`src/main/library/metadata.ts:139`) discards them — `TrackTags` has no lyrics field today. This
   is the cheapest tier to add and the one that costs nothing at runtime.

The tier that wins is recorded in `LyricsDocument.source`, because W17-3 attributes it and W17-5
needs to know what a manual override is replacing.

## Sidecar resolution — the path invariant applies

Resolve the audio file through the existing rejoin (`store.resolveTrackPath` /
`toAbsPath` in `src/main/db/paths.ts`), then swap the extension. **Never store an absolute path**
for the sidecar and never store a second copy of the path — derive it on read. Search order:
exact-case `.lrc`, then a case-insensitive directory match, because Linux is case-sensitive and a
`Track.LRC` written on Windows is a real file that must still resolve. Read as UTF-8 with a BOM
strip; fall back to latin-1 on invalid UTF-8 rather than returning mojibake (old `.lrc` files are
frequently not UTF-8).

Byte-cap the read. A `.lrc` is kilobytes; refuse anything implausible rather than slurping a file
that happens to share the basename.

## Embedded tags

Extend `TrackTags` with `lyrics: string | null` and read it in `toTrackTags`:

- ID3: `USLT` (unsynced) and `SYLT` (synced). **`SYLT` support is thin across the ecosystem and
  in `music-metadata` specifically — verify what it actually surfaces before relying on it.** In
  practice most embedded *synced* lyrics are LRC text stuffed into `USLT`, which is why the
  extracted text is run through `isSyncedLyricsText` from W17-1 rather than assumed plain.
- Vorbis/FLAC: `LYRICS`, `UNSYNCEDLYRICS`, `SYNCEDLYRICS`.
- MP4: `©lyr`.

Prefer `common.lyrics` if it covers these; drop to native frames where it does not. Decide and
record whether lyrics are read on **scan** (stored, adds a column and scan cost for a field most
tracks lack) or **on demand** at Now Playing time (one extra `parseFile` per track change). Default
recommendation: **on demand** — it keeps schema v1 and the scan path untouched for a feature that
is only ever read for the one track currently playing.

## IPC

- `src/shared/ipc.ts` — add `lyrics.get` (request `{ trackId }`, response `LyricsDocument | null`).
  Note the registry has a completeness check (`src/main/ipc/registry.ts:96`): a channel declared in
  shared and never registered fails at startup, so both halves land together.
- Register the handler alongside the other library channels in `src/main/ipc/`.
- Renderer opens no file and no socket — the resolver is main-process only, per the invariant.

## Files

- `src/main/library/lyrics/sidecar.ts`, `src/main/library/lyrics/service.ts` (the tier resolver,
  with the tier-3 seam).
- `src/main/library/metadata.ts` — `TrackTags.lyrics` + extraction in `toTrackTags`.
- `src/shared/ipc.ts`, `src/main/ipc/`.

## Tests

Sidecar found/absent; case-mismatched extension; non-UTF-8 sidecar; oversized file refused; sidecar
beats embedded; embedded LRC-in-`USLT` detected as synced; embedded plain text yields
`synced: false`; a track whose file has moved returns `null` rather than throwing; no absolute path
is persisted anywhere (assert against the `oscine/no-windows-path-literals` spirit — derive, don't
store).

## Out of scope

No network (W17-4), no UI (W17-3), no manual override or offset (W17-5). Does not write anything to
the audio file.
