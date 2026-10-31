---
taskId: 01M69GAC4MDQV5W0YRVEB5V6YH
title: 'Smart playlists — kind, brief, agent notes and exclusions'
status: todo
priority: medium
labels:
  - D36.8
  - main
  - migration
  - renderer
workstream: W24
workstreamId: W24-9
dependsOn:
  - 01M69G9T4XSKH41NRZ5GVNG7K4
order: 23
created: '2026-10-31T17:32:33.299Z'
updated: '2026-10-31T17:37:35.777Z'
---
Spec: wiki `oscine-mcp` → D36.8.

A playlist flagged **smart** is one any agent may read and keep up to date on request. The app never refreshes one itself (D36).

- **Migration** (number at merge): `playlists.kind` (`'static'` | `'smart'`, default `'static'`), `brief` (operator-owned text), `agent_notes` (agent-owned text), `refreshed_at`; table `playlist_exclusions` (playlist id, track id, source, created_at).
- **Operator removal from a smart playlist creates an exclusion**; adding the track back by hand clears it. This is in `PlaylistService`, so it holds for every caller.
- **Agent adds skip excluded tracks** and report them as skipped. Agent removal accepts `exclude: true`.
- **MCP:** `list_playlists` / `get_playlist` include kind, brief, notes, exclusions; `set_smart_playlist` (kind, brief) and `update_agent_notes`; adds stamp `refreshed_at`. All Organize capability, journaled.
- **Server `instructions`** explain smart playlists; a **`refresh_smart_playlists` prompt** walks an agent through: read brief + notes + entries + exclusions, query for what's missing, add, update notes.
- **UI:** a badge in the sidebar; Make smart / Make static in the playlist context menu; a brief editor and an exclusions list (with clear) in the playlist header. Copy says what it means: "Smart: kept up to date by your agent". No "ask the AI" control anywhere.
- **Export bundle:** mark the new columns and table carried in `src/main/bundle/tables.ts`, ready for when the bundle's playlist section is implemented.

**Tests:** removal → exclusion → skip-on-add → re-add clears; `kind` round-trips; a smart playlist with no agent behaves as an ordinary playlist in playback and export (m3u8).

**Done when:** the operator marks a playlist smart with a brief, asks an agent to refresh it, sees missing tracks appear, removes one, and a second refresh does not bring it back.
