---
taskId: 01M126ZRER5HXPM5TY9EYKKMJS
title: >-
  Tunedeck "Tags" pane: file genres + editable user tags, with album/artist
  batch apply
status: backlog
priority: medium
labels: []
workstream: W15
workstreamId: W15-3
workstreamDependsOn:
  - W7
dependsOn:
  - 01M126ZBGXQZ8QTJ9W6E5N2CBS
order: 12
created: '2026-08-27T18:16:18.136Z'
updated: '2026-08-27T18:16:18.136Z'
---
The edit surface, as a new group under the Track tab in the Tunedeck registry (`src/renderer/panels/tunedeck/panes.ts`).

## Placement

A `TagsPane` group under the existing `track` tab, id `track-tags`, icon `i-tabler-tags` (note: `i-tabler-tag` is taken by the Neighbourhood group). It is an **operator's-own-record** group — local, works with online lookups declined — the same category as `FavoriteSongsPane` and its D14-third-rule note. Order it as a sibling of the favorites/listening groups (operator's record), after the file-describing groups (Format/ReplayGain/Decode).

## Content

- **File genres** render as read-only, origin-marked chips (from `tags.forTrack().file`). Muted, non-removable, visibly "from the file's tag."
- **User tags** render as editable chips (from `.user`): each removable, plus an add affordance (free-text input with autocomplete against `tags.list` vocabulary).
- **Batch apply.** Default target is the current track. Offer "apply to this album" and "apply to everything by this artist" — this is why `tags.add` takes `trackIds[]`. Resolve the album/artist track sets via the existing library queries the deck already has for the current subject.

## Behaviour

- Fully local; renders and edits with the network unplugged. No part of add/remove is gated.
- Follows the deck's editorial voice — the `hint` string names what the group is and that it is the operator's record, in the register of the surrounding hints.

## Out of scope

The suggestion chips (next card layers them into this pane — leave a clearly-marked seam for a "Suggested" section), the TrackList column.
