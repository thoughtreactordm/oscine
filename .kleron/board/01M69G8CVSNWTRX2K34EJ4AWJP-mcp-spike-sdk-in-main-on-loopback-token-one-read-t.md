---
taskId: 01M69G8CVSNWTRX2K34EJ4AWJP
title: 'MCP spike — SDK in main on loopback, token, one read tool'
status: todo
priority: medium
labels:
  - D36.1
  - D36.2
  - D36.4
  - main
  - spike
workstream: W24
workstreamId: W24-1
order: 15
created: '2026-10-31T17:31:28.503Z'
updated: '2026-10-31T17:37:35.292Z'
---
Spec: wiki `oscine-mcp` → D36.1, D36.2, D36.4.

The gate for the rest of the stream. Prove the shape end to end with one tool, and settle the two open mechanisms the page defers to this card.

- **`@modelcontextprotocol/sdk` + zod** added; the server in `src/main/mcp/`, driven by a plain `node:http` server and the SDK's Streamable HTTP server transport (not its Express helpers).
- **Bound to `127.0.0.1` only.** Bearer token required on every request (a hard-coded dev token is fine here; `safeStorage` is W24-2). `Origin` and `Host` checked; a browser `Origin` is refused.
- **One tool, `library_overview`**: track/album/artist counts, formats, roots by name, and per-tag coverage counts, built on existing services.
- Behind a dev flag only; no setting yet.
- **Claude Code connects** (`claude mcp add --transport http …`) on Windows and Linux, and the tool returns correct data on the synthetic library.

**Findings to record on `oscine-mcp`:**
1. **The `query_library` confinement mechanism**: how `settings` and any credential-bearing column are kept out of a read-only worker connection (authorizer if better-sqlite3 or `node:sqlite` exposes one; otherwise a stated fallback). Prototype it, don't just pick it.
2. **Packaged size impact** of the SDK's dependency tree on `npm run pack`, both platforms.

**Done when:** Claude Code calls `library_overview` against the running app on both platforms, a request without the token or with a foreign `Origin`/`Host` is refused (tested), and both findings are on the wiki page.
