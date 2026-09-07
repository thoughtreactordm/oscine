---
taskId: 01M1FGD9VFEQSBSP51ESQ19SRZ
title: 'Lyrics: manual match and per-track timing offset (migration)'
status: backlog
priority: low
labels:
  - lyrics
  - schema
  - ui
workstream: W17
workstreamId: W17-5
dependsOn:
  - 01M1FGBMSG6TS1EZ3FSMBNWAM9
  - 01M1FGCGD47Z8HCK8FBNTQ0821
order: 14
created: '2026-09-01T22:11:06.735Z'
updated: '2026-09-01T22:11:36.048Z'
---
## Intent

The correction layer. Community LRC files drift and duration matching is not infallible, so the
operator needs three things: nudge the timing, pick a different match, and say "this track has no
lyrics, stop looking". Without the offset nudge in particular, **the first mismatched file reads as
"the feature is broken"** rather than "this file is off by 300 ms" — which is why this card exists
rather than being deferred indefinitely.

Same visible-and-correctable stance R5 takes on artist identity and W15 takes on suggested tags: an
automatic match is a claim about the world, so it is shown, attributed, and overridable.

## Storage — decisions, not derivations

This is the load-bearing distinction and the reason the card carries a migration. A *fetched
document* is derived and re-derivable, so it belongs in `cache.db` (W17-4) and is correctly absent
from D11's bundle. An operator *decision* is neither, so it belongs in `library.db` and must
survive a cache wipe.

New migration under `src/main/db/migrations/` (next in sequence after `022-track-genres-album.ts`),
adding a per-track row holding:

- `offset_ms INTEGER` — the timing nudge.
- `lrclib_id INTEGER NULL` + a source marker, mirroring the `artists.mbid` / `mbid_source =
  'manual' | 'auto'` pattern (`src/main/musicbrainz/store.ts:100`), so a manual pick is never
  clobbered by a later automatic one — the same `WHERE source IS NULL OR source = 'auto'` guard.
- A "suppressed" flag for "no lyrics for this track", which must stop tier-3 fetching entirely, not
  just hide the pane.

`ON DELETE CASCADE` from `tracks`.

**Open question to settle in build: do these rows join D11's export bundle?** The case for is that
they are per-track operator statements, exactly like ratings, and both fields are machine-
independent — an `lrclib_id` means the same thing everywhere, and a timing offset is a property of
the recording, not of the machine. The case against is that they are worthless without the same
files present, and D11 has repeatedly chosen to carry only what merges cleanly. Pick one and record
the reasoning on the card; do not leave it implicit.

## Offset UI

A ±nudge on the lyrics pane, adjusting in small steps (~100 ms) with the effect visible immediately
against the playing track — an offset control you cannot hear while adjusting is unusable. Applied
*on top of* the document's own `[offset:]` tag from W17-1, not instead of it; make the composition
order explicit in a comment, because this is the second-most-inverted detail in LRC handling after
the offset sign itself.

## Manual match

Surface `/api/search` results (W17-4) in a small picker: artist / title / album / duration, with
the duration delta from the playing track shown, since that is the field that tells the operator
which result is right. Choosing one pins `lrclib_id` with source `'manual'`. Also allow clearing
back to automatic.

Reachable from the lyrics pane's source attribution — that is what W17-3 left it there for. Should
also be reachable from the Tunedeck if the pane is hosted there, but do not build a second entry
point in this card.

## Files

- `src/main/db/migrations/0NN-track-lyrics.ts`.
- `src/main/library/store.ts` — read/write with the auto-vs-manual guard.
- `src/main/lyrics/service.ts` — honour offset, pinned id and suppression in the resolution chain.
- `src/shared/ipc.ts` — `lyrics.setOffset` / `lyrics.setMatch` / `lyrics.suppress` (+ registry).
- `src/renderer/panels/LyricsPane.vue` + a small picker component.

## Tests

Migration up on a populated DB; offset composes with the document's `[offset:]` in the stated
order; a manual pin survives an automatic re-resolution; suppression prevents a network request
(assert at the client); clearing returns to automatic; cascade on track delete.

## Out of scope

No editing of lyrics *text* — this is match and timing only. No write-back to the audio file: that
would be a W16 payload through the staged review, and it is explicitly not in this stream. No
per-album or per-artist offset.
