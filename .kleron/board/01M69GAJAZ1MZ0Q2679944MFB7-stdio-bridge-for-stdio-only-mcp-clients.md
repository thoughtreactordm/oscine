---
taskId: 01M69GAJAZ1MZ0Q2679944MFB7
title: Stdio bridge for stdio-only MCP clients
status: todo
priority: low
labels:
  - D36.1
  - packaging
workstream: W24
workstreamId: W24-10
dependsOn:
  - 01M69G8KQBR5B03QNP715BSCH5
order: 24
created: '2026-10-31T17:32:39.645Z'
updated: '2026-10-31T17:37:35.835Z'
---
Spec: wiki `oscine-mcp` → D36.1.

For clients that only launch MCP servers over stdio (Claude Desktop's local config).

- **A small script in `resources/`**, run as `ELECTRON_RUN_AS_NODE=1 <oscine binary> <script>`, so no separate Node install is needed.
- It **forwards stdio JSON-RPC to the loopback Streamable HTTP server** with the token (passed by env var in the client config). It never takes the single-instance lock, opens the database or loads app code.
- **The app not running** is a clear MCP error ("Oscine is not running or agent access is off"), not a hang.
- **Packaged on both platforms** via `electron-builder.yml` `extraResources`; paths in the generated snippet are resolved per platform, with no hand-rolled separators (`oscine/no-windows-path-literals`).
- The **Claude Desktop snippet** in Settings → Agent access (W24-2) is filled in with the real binary and script paths.

**Done when:** Claude Desktop, configured from the pasted snippet, lists and calls Oscine's tools on a packaged build on Windows and Linux, and gets the clear error when the app is closed.
