---
taskId: 01M69G9AMRZADFFJWMMYG3ACX7
title: query_library — read-only SQL over mcp_* views in a worker
status: todo
priority: medium
labels:
  - D36.4
  - R19
  - main
  - migration
workstream: W24
workstreamId: W24-5
dependsOn:
  - 01M69G8CVSNWTRX2K34EJ4AWJP
order: 19
created: '2026-10-31T17:31:58.999Z'
updated: '2026-10-31T17:37:35.538Z'
---
Spec: wiki `oscine-mcp` → D36.4, R19.

- **Migration** adding the `mcp_*` views: `mcp_tracks` (effective values: file tags with `track_overrides` and `track_tag_overrides` applied; root name + relative path; format and audio properties; play count, last played), `mcp_albums`, `mcp_artists`, `mcp_playlists`, `mcp_playlist_entries`, `mcp_listens`. These are a public contract: a breaking change is a new view, not an edit. Number assigned at merge.
- **`describe_views`** returns every view's columns and types (also offered as an MCP resource).
- **Worker thread** with its own `readonly` connection and `PRAGMA query_only = ON`, on the `artworkWorker` / ReplayGain worker pattern. WAL lets it read during main-connection writes.
- **One statement, must be a reader** (better-sqlite3's `Statement.reader`); `ATTACH`, pragma writes, `VACUUM INTO` and anything else refused before it runs.
- **Confinement** of `settings` and credential-bearing data, using the mechanism W24-1 recorded.
- **Wall-clock timeout** (worker terminated and replaced at the deadline) and a **row cap** (result flags truncation).

**Tests:** each refused statement class; the confinement holding against direct and indirect references (subquery, CTE, view); a deliberately slow cross join is killed at the deadline while a concurrent IPC call on the main connection returns promptly; truncation reported; `mcp_tracks` equals the values the track list shows for an overridden track.

**Done when:** an agent can run arbitrary SELECTs over the views on the 100k synthetic library without the UI stalling, and cannot read `settings` or write anything.
