---
taskId: 01M0N56FHRHQTTAZMA2MN736G3
title: 'Play, queue, and save shelf as playlist'
status: todo
priority: high
labels:
  - ui
  - playlists
  - D20
workstream: W12
workstreamId: W12-5
dependsOn:
  - 01M0N564GA0Y4AVY2QPN8D6ABC
  - 01M0N554FR56WRJ0B85AES6HF1
order: 0
created: '2026-08-22T16:34:53.623Z'
updated: '2026-08-28T17:33:08.302Z'
---
Spec: wiki `fermata-discover-1-0` → Play actions, `discover.saveShelf`.

The pane copy already promised a shelf can become a playlist. This is that gesture, plus play.

**Play.** Album card activates the album in disc/track order through the existing library album activation — do not invent a second play-order builder. Track card uses the same `trackActivation` path as a TrackList row. Queue is TrackList's existing secondary gesture, per item. No "queue the whole shelf" unless multi-select falls out for free.

**Save.** `discover.saveShelf({ recipeId })` materializes the **last `shelves` result**, not a re-query. Expand album items to tracks in disc/track/id order. `playlists.create` named `{shelf.title} · {dayKey}`, then `playlists.addTracks`. The new playlist becomes the viewed Curate stop.

Re-saving tomorrow may create a second playlist with a new `dayKey`. That is correct for a snapshot. Do not dedup by name. Do not make it a live smart playlist.

**Tests:** save against a cached result produces exactly those track ids; a subsequent compose that would have picked differently does not change the playlist already saved.

**Done when:** activating an album card plays it, saving a shelf lands you on an ordinary D12 playlist of those tracks, and Discover itself is unchanged.
