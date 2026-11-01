---
taskId: 01M69G8T9JM6NJ7XXN3RY49M1F
title: 'library.changed — coalesced change event for playlists, overrides and tags'
status: done
priority: medium
labels:
  - D36.9
  - ipc
  - main
  - renderer
workstream: W24
workstreamId: W24-3
order: 22
created: '2026-10-31T17:31:42.256Z'
updated: '2026-11-01T03:29:07.651Z'
---
Spec: wiki `oscine-mcp` → D36.9. Independent of MCP; can land first.

Today the only main→renderer events are `settings.changed`, `scrobble.statusChanged`, `update.changed` and `theme.noctaliaChanged`. The renderer assumes it is the only thing editing playlists, overrides and tags, so an agent's edit would not appear until a reload.

- **`library.changed`** in `src/shared/ipc.ts`: a payload naming what changed by kind (`playlists`, `playlistEntries`, `overrides`, `tagOverrides`, `tags`) and the affected ids. Sent through `emit` (`src/main/ipc/registry.ts:103`).
- **Emitted from the services**, not the IPC handlers, so a write from any caller (IPC today, MCP later) announces itself.
- **Coalesced:** one event per committed service call, never one per row. A 500-track override set is one event.
- **Renderer:** the playlist, override and tag stores refetch exactly what is named. A store that triggered the change itself must not double-apply or flicker.

**Tests:** a bulk service call emits exactly one event with every id; the renderer store refetch logic (pure, `@renderer`-free) applies a payload correctly; a self-originated change is idempotent.

**Done when:** an edit made through a service with no renderer involvement (a test harness or dev command) shows up in the open sidebar, track list and Tunedeck without a reload.
