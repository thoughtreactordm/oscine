---
taskId: 01M69G8KQBR5B03QNP715BSCH5
title: Agent access settings and server lifecycle
status: in-review
priority: medium
labels:
  - D36.1
  - D36.7
  - D36.10
  - main
  - renderer
  - settings
workstream: W24
workstreamId: W24-2
dependsOn:
  - 01M69G8CVSNWTRX2K34EJ4AWJP
order: 16
created: '2026-10-31T17:31:35.529Z'
updated: '2026-10-31T19:49:01.865Z'
---
Spec: wiki `oscine-mcp` → D36.1, D36.7, D36.10.

- **Descriptors** in `src/shared/settings/`: `mcp.enabled` (default off), `mcp.port` (fixed default), and the three capability keys (Read, Organize, Stage corrections; each on by default once enabled). Machine-local, not portable.
- **Lifecycle:** toggling on starts the listener, toggling off closes it and ends every session. **Nothing listens while off** (tested).
- **Token:** generated on first enable, stored with `safeStorage`, shown with copy, regenerate ends existing sessions. Never in the settings table or the export bundle.
- **Port in use** is a visible error in the Settings section, not a fallback port.
- **Capability gating:** a tool whose capability is off is not listed; changing a capability sends `notifications/tools/list_changed`.
- **Settings → Agent access**, generated from the registry where possible: toggle, port, capabilities, token, ready-to-paste config for Claude Code, Claude Desktop (bridge, filled in by W24-10) and generic clients, and connected sessions with client names.
- **Title-bar indicator** while a session is active, and while a write is in flight; clicking opens the section.

**Done when:** an operator can turn the server on from Settings, paste the Claude Code snippet, connect, see the session listed and the indicator lit, switch a capability off and watch its tools disappear from the client, and turn the server off with the port closed.
