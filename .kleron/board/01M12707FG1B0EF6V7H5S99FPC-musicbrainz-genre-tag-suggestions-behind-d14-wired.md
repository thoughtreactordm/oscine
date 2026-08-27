---
taskId: 01M12707FG1B0EF6V7H5S99FPC
title: 'MusicBrainz genre/tag suggestions behind D14, wired into tags.suggest'
status: backlog
priority: medium
labels: []
workstream: W15
workstreamId: W15-4
workstreamDependsOn:
  - W7
dependsOn:
  - 01M126ZRER5HXPM5TY9EYKKMJS
order: 13
created: '2026-08-27T18:16:33.519Z'
updated: '2026-08-27T18:16:33.519Z'
---
The networked suggestion path — Oscine's use of the D14 net/cache layer W7 already shipped, not a second HTTP stack.

## Fetch

MusicBrainz returns vote-weighted `genres[]` and `tags[]` (each with a `count`) on artist and release-group entities. The integration does **not** fetch these today (it parses identity, relations, URLs only). Extend the existing MB parse in `src/main/musicbrainz/` to pull `genres`/`tags` from the artist and release-group lookups already being made — prefer piggybacking the existing requests over adding new round-trips where the entity is already fetched.

## Gate — inherit D14 for free

Route through the single gateway: `CacheService.through('musicbrainz.artist-tags', mbid, fetch)` (and a release-group variant), with its own TTL in the cache-TTL table. This inherits the whole D14 model:
- fresh cache answers even with consent off;
- stale beats a failure (`declined`/`offline`/`timeout`/`rate-limited`/`unavailable`);
- suggestions behave exactly like Biography and Members — present when online or warm, silently absent when declined, while the local tag editor from the pane card keeps working.

Do NOT reopen D14 or add a new consent surface — reuse the existing gate and `NET_SCOPES`.

## `tags.suggest` and the pane

- Wire `tags.suggest(trackId)` (stubbed in the IPC card) to resolve the track's artist/release MBIDs and return deduped, vote-weighted suggestions, keyed on the shared casefold so a suggestion that equals an existing file genre or user tag is marked/collapsed rather than shown as new.
- Render as a "Suggested" section in the Tags pane (the seam left by the pane card): chips ordered by vote weight.
- **Nothing auto-applies.** Tapping a suggestion calls `tags.add` with `source='suggested'` — the visible-and-correctable stance R5 takes on identity. A suggestion is a claim about the world; acceptance makes it the operator's record.
- **Granularity.** MB tags are per-artist and per-release-group, so a suggestion is really "for this artist / this release." Accept applies to the current track by default and offers the same album/artist batch as manual add.

## Tests

Fresh/stale/declined behaviour of the new cache entity; dedup-against-existing keying; that decline leaves the local editor working.
