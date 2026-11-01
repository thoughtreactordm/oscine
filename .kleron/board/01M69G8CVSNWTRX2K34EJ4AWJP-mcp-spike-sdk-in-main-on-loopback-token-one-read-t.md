---
taskId: 01M69G8CVSNWTRX2K34EJ4AWJP
title: 'MCP spike — SDK in main on loopback, token, one read tool'
status: done
priority: medium
labels:
  - D36.1
  - D36.2
  - D36.4
  - main
  - spike
workstream: W24
workstreamId: W24-1
order: 0
created: '2026-10-31T17:31:28.503Z'
updated: '2026-10-31T19:32:20.306Z'
---
Spec: wiki `oscine-mcp` → D36.1, D36.2, D36.4.

The gate for the rest of the stream. Prove the shape end to end with one tool, and settle the two open mechanisms the page defers to this card.

- **`@modelcontextprotocol/sdk` + zod** added; the server in `src/main/mcp/`, driven by a plain `node:http` server and the SDK's Streamable HTTP server transport (not its Express helpers).
- **Bound to `127.0.0.1` only.** Bearer token required on every request (a hard-coded dev token is fine here; `safeStorage` is W24-2). `Origin` and `Host` checked; a browser `Origin` is refused.
- **One tool, `library_overview`**: track/album/artist counts, formats, roots by name, and per-tag coverage counts, built on existing services.
- Behind a dev flag only; no setting yet.
- **Claude Code connects** (`claude mcp add --transport http …`) on Linux, and the tool returns correct data. ~~on Windows and Linux~~: the Windows pass is deferred to W24-11 (see below).

**Findings to record on `oscine-mcp`:**
1. **The `query_library` confinement mechanism**: how `settings` and any credential-bearing column are kept out of a read-only worker connection (authorizer if better-sqlite3 or `node:sqlite` exposes one; otherwise a stated fallback). Prototype it, don't just pick it.
2. **Packaged size impact** of the SDK's dependency tree on `npm run pack` (Linux; Windows deferred to W24-11).

**Done when:** Claude Code calls `library_overview` against the running app on Linux, a request without the token or with a foreign `Origin`/`Host` is refused (tested), and both findings are on the wiki page.

---

## Scope change (owner, 2026-10-31)

The owner dropped the Windows pass from this card: "We can ignore Windows for now, so we can keep moving." **The Windows Claude Code connect check and the Windows packaged-size measurement are deferred to W24-11's Windows verification. W24-1 does not owe them.** Recorded on [[oscine-mcp]] under D36.1, D36.2 and the cards table.

## Evidence

- **Live connect (Linux, 2026-10-31, verified by the owner):** with `OSCINE_MCP_DEV=1 npm run dev` running, the owner ran `claude mcp add --transport http oscine http://127.0.0.1:47318/mcp --header "Authorization: Bearer oscine-dev-token"`. Claude Code connected to the in-app MCP server and `library_overview` returned results.
- **Refusals tested:** `tests/main/mcp/server.test.ts` runs a real loopback listener and covers a missing or wrong token (401), a browser `Origin` (403) and a foreign `Host` (421). `tests/main/mcp/requestGuard.test.ts` covers the guard unit by unit.
- **Finding 1, confinement:** a `node:sqlite` read-only worker connection with a `(table, column)` allowlist authorizer derived from the `mcp_*` views. Prototyped in `src/main/mcp/sqlConfinement.ts` and proven in `tests/main/mcp/sqlConfinement.test.ts`. On the wiki under D36.4.
- **Finding 2, size (Linux):** the SDK and zod add +9.96 MB uncompressed to `app.asar` (about 1.9 MB gzipped). On the wiki under D36.2.
- **Gate on the branch:** lint, typecheck, format:check and tests all pass (305 files, 4603 tests).

Commits: c15b250 (server + `library_overview`), 759eb7e (confinement prototype).
