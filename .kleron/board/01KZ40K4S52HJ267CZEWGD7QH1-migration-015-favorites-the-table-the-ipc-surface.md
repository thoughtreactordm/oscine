---
taskId: 01KZ40K4S52HJ267CZEWGD7QH1
title: 'Migration 015 — favorites: the table, the IPC surface, and the heart'
status: done
priority: high
labels:
  - schema
  - ipc
  - ui
  - D18
workstream: W10
workstreamId: W10-6
order: 14
created: '2026-08-03T14:31:38.533Z'
updated: '2026-08-04T15:06:59.025Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → D18 and → Favorites.

```sql
CREATE TABLE track_favorites (
  track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL       -- UTC ms; the rail's default order
);

CREATE INDEX idx_track_favorites_at ON track_favorites(favorited_at);
```

**`CASCADE` here, unlike `listens`, and the difference is the point.** A favorite is a statement about a track you can play; one you cannot is a broken row in a pinned playlist, not a favorite. Losing it to a folder move is one click to fix, where losing listening history is unrecoverable. Cross-machine durability for favorites lives in D11's bundle (W10-13), not in the delete rule.

**IPC** (starting in `src/shared/ipc.ts`): `favorites.toggle(trackId)`, `favorites.state(trackIds[])` for a batch, `favorites.list` paged like every other list. `toggle` returns the resulting state so the renderer never guesses.

**In lists.** `Track` grows a `favorite: boolean`, resolved in the same query that builds a page — the heart on a virtualized row must cost nothing extra, and a second round trip per page would defeat the point. Add a heart column to `TrackList.vue` through the existing column chooser, off by default. Make `NowPlaying.vue`'s existing placeholder real.

**Favorites are local and authoritative.** Last.fm's loved tracks are never read in. Pushing *out* is W11-6 and is deliberately a separate card — this one must work fully with no account connected.

**Tests:** toggle is idempotent per state; `favorites.state` over 10k ids stays one query; deleting a track removes the favorite; the batch endpoint respects the same page ceiling as its neighbours in `src/shared/library.ts`.

**Done when:** hearting a track in NowPlaying persists across a restart and shows filled on the matching TrackList row.
