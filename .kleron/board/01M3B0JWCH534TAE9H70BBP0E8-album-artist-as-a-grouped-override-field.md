---
taskId: 01M3B0JWCH534TAE9H70BBP0E8
title: Album artist as a grouped override field
status: done
priority: high
labels:
  - '1.1'
  - tag-writeback
workstream: W16
workstreamId: W16-14
order: 10
created: '2026-09-25T00:48:58.256Z'
updated: '2026-09-27T00:20:50.413Z'
---
Design: `oscine-tag-writeback` → "The full tag surface", **Decision E** (grouped tier).

## Why
A ripped compilation carries no album-artist frame, so the scanner falls back to each track's performer (`store.ts` `writeTrack`) and the album shatters into one row per performer. `c9ddc5d` fixed new rips; existing files cannot be corrected in-app because the override layer does not model album artist. This card is the operator's fix for everything already ripped or badly tagged.

## Scope
- Migration: `track_overrides` += `album_artist_name TEXT` (number at landing; sequence against W17's pending migration).
- `OverrideField` / `OverridePatch` += `albumArtist`; IPC validation in `src/main/ipc/validate.ts`.
- `applyOverride`: setting album artist upserts the artist and moves the track to the `(album title, album artist)` album row via `upsertAlbum`; clearing it falls back to the performer, exactly as the scanner does. Mind the interaction with the existing album branch (`base.albumArtistId ?? artistId`) — an album edit must now honour a pending album-artist override.
- `revertOverride`: restore from the file's `albumArtist` with the same fallback.
- Orphaned album/artist rows after a re-key are pruned by the existing prune path (check the Artist facet does not show an empty artist).
- Write-back: `WritebackField` += `albumArtist`; diff against a fresh read; `WritableTags.albumArtist` (already optional since `c9ddc5d`) set only when the override exists, so a flush without one still leaves the frame untouched; verify compares it; `retireWrittenOverrides` clears the column.
- Editor: album-artist input in `TrackMetadataEditor` beside artist, with batch "mixed" folding. Review UI row.

## Acceptance
- Batch-select a shattered compilation, set album artist "Various Artists" → it is one album in the Album list and one "Various Artists" entry in the Artist facet, instantly, before any flush.
- Revert restores the shattered state.
- Flush writes ALBUMARTIST on all five codecs; a rescan after a library wipe reads one album with an empty `track_overrides`.
- Store tests cover re-key, revert, and album-then-album-artist edit ordering.
