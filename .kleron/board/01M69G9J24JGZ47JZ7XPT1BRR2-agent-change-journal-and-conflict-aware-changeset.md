---
taskId: 01M69G9J24JGZ47JZ7XPT1BRR2
title: Agent change journal and conflict-aware changeset revert
status: in-review
priority: medium
labels:
  - D36.6
  - main
  - migration
  - renderer
workstream: W24
workstreamId: W24-6
dependsOn:
  - 01M69G8CVSNWTRX2K34EJ4AWJP
order: 20
created: '2026-10-31T17:32:06.594Z'
updated: '2026-10-31T21:25:49.969Z'
---
Spec: wiki `oscine-mcp` → D36.6.

- **Migration:** `agent_changesets` (id, client name, description, started_at, ended_at) and `agent_changes` (changeset id, entity kind, entity id, field, before JSON, after JSON). Number assigned at merge. Classified machine-local in `src/main/bundle/tables.ts`, like `play_history`.
- **Write wrapper** in `src/main/mcp/`: reads before, calls the service, reads after, records both in one transaction with the service write. Every later write tool (W24-7, W24-8, W24-9) goes through it; no tool writes without it.
- **Changesets** open explicitly with `begin_changeset(description)` or implicitly per MCP session.
- **Revert is conflict-aware:** a change is restored to *before* only if the current value still equals *after*. Otherwise that row is skipped and reported. `revert_changeset` returns restored and skipped counts.
- **Settings → Agent access** lists recent changesets (client, description, time, counts) with a Revert button and a result summary.

**Tests:** before/after recorded for each entity kind; revert restores an untouched change; revert skips a row the operator edited since and reports it; reverting twice is a no-op; a playlist emptied by an agent is fully restored, entry order included.

**Done when:** every agent write is attributable to a changeset and any changeset can be reverted without clobbering later manual edits.
