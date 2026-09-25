---
taskId: 01M3D7PRB92M9ZKRSQDHKNXEDX
title: Apple MusicBrainz artist-id setters throw on clear
status: triage
priority: low
labels:
  - '1.1'
  - tag-writeback
  - gate
triageKind: bug
workstream: W16
workstreamId: W16-20
order: 2
created: '2026-09-25T21:31:54.087Z'
updated: '2026-09-25T21:31:54.087Z'
---
Found by the W16-16 per-field corpus gate (`npm run probe:writeback-corpus`), linux/x64.

**Red cells:** `musicBrainzArtistId` × aac and `musicBrainzReleaseArtistId` × aac, both `written:<field>:clear`.

node-taglib-sharp's `AppleTag` setters for these two fields call `v.split("/")` before storing, because MB artist ids are multi-valued and joined with `/`. The gate's clear contract for `text` fields is `undefined` (`CLEAR_VALUE` in `scripts/lib/writeback-field-cases.mjs`), and on `.m4a` the setter throws `Cannot read properties of undefined (reading 'split')`. `null` throws the same way. The other three containers accept `undefined`.

A one-off experiment shows that `''` clears both fields on `.m4a` (they read back as `undefined`). The gate was not changed to use `''`: the clear contract applies to all text fields, and changing it to turn a cell green is exactly the quiet fix the gate forbids.

**Status:** both fields stay held (`admitted: false`) in `src/shared/tagFields.ts`.

**To resolve:** decide the writer's text-clear contract (W16-17). Either (a) `''` for every text field, or (b) a per-field exception for these two Apple setters. Update `CLEAR_VALUE` or the field case to match, then re-run the gate on both platforms. Also worth checking: an id value that contains `/` is stored as several iTunes strings. Confirm it reads back joined, so a multi-artist id round-trips.
