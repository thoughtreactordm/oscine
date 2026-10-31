---
taskId: 01M69G9T4XSKH41NRZ5GVNG7K4
title: Organize tools — playlist edits and user tags through services
status: todo
priority: medium
labels:
  - D36.5
  - D36.7
  - main
workstream: W24
workstreamId: W24-7
dependsOn:
  - 01M69G8T9JM6NJ7XXN3RY49M1F
  - 01M69G9J24JGZ47JZ7XPT1BRR2
order: 21
created: '2026-10-31T17:32:14.875Z'
updated: '2026-10-31T17:37:35.665Z'
---
Spec: wiki `oscine-mcp` → D36.5, D36.7.

The Organize capability. Every tool calls the same service the IPC handler calls, through the W24-6 journal wrapper.

- **Playlists** via `PlaylistService`: `create_playlist`, `rename_playlist`, `add_to_playlist` (with the existing `insertion` shapes), `move_playlist_entries`, `remove_playlist_entries`, `reorder_playlists`. A `set_playlist_order` convenience that takes a full entry-id order, since agents reason about whole orderings.
- **User tags** (W15) via the tags service: add and remove on tracks.
- **No `delete_playlist`** in v1 (Deferred on the page). **No favorites**: they push to Last.fm as Loved (D19).
- **`dryRun`** on every tool returns the diff it would apply.
- **At most 500 tracks or entries per call**; over the cap is a validation error that says how to split the call.
- Each call emits one `library.changed` (W24-3).

**Tests:** each tool round-trips through the service and the journal; `dryRun` writes nothing; the cap; a playlist built by an agent appears in the open sidebar; reverting the changeset restores the original.

**Done when:** an agent can build, reorder and edit a 200-track playlist on request, the operator watches it appear live, and one Revert undoes it.
