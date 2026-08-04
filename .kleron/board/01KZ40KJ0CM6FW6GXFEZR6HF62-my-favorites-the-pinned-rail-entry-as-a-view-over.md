---
taskId: 01KZ40KJ0CM6FW6GXFEZR6HF62
title: '"My Favorites" — the pinned rail entry as a view over the table'
status: done
priority: medium
labels:
  - ui
  - W5-adjacent
  - D18
workstream: W10
workstreamId: W10-7
dependsOn:
  - 01KZ40K4S52HJ267CZEWGD7QH1
order: 12
created: '2026-08-03T14:31:52.075Z'
updated: '2026-08-04T15:06:58.999Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → D18 and → Favorites → "The rail entry".

The pinned, permanent collection the operator asked for — rendered from `track_favorites`, **not** stored as a `playlists` row.

- Pinned above the playlist tabs in `PlaylistRail.vue` / `PlaylistTabBar.vue`. Cannot be renamed, reordered or deleted; the rename and delete affordances are absent rather than present-and-disabled.
- Renders through `PlaylistContents.vue` against a source reading `track_favorites` instead of `playlist_entries`. `trackListSource.ts` already models exactly this indirection — extend it rather than forking the contents pane.
- Default order `favorited_at` descending. Album ordering, per `PlaylistEntryOrder`, is a reasonable second option and cheap if the source abstraction is right.
- **Reorder is disabled.** There is no authored position to drag against. This is the honest face of D18's accepted cost, not a bug — say so where a reader will hit it.
- Removing a row un-favorites the track. It is the same gesture as un-hearting, and having two ways to do it that behave differently would be worse than one that is slightly surprising.

**Watch the identity mismatch.** Everything in `src/shared/playlists.ts` keys off the `playlist_entries` id, because D12 makes the same track legal twice. Favorites key off `track_id` and duplicates are impossible. Do not paper over this by minting fake entry ids — let the source declare which identity it speaks, and let selection and removal follow.

**Tests** (`tests/renderer/panels/`): the entry is present with zero favorites and shows an empty state rather than vanishing; un-favoriting the last row leaves the entry in place; the entry does not appear in the reorder drag targets for real playlists.

**Done when:** hearting a track from anywhere makes it appear at the top of My Favorites without a manual refresh, and the entry survives creating, reordering and deleting ordinary playlists around it.
