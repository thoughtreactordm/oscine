---
taskId: 01M4J4BDWAMGQGVQYWFBDEK1B2
title: '`recaps` storage — migration, bundle classification, IPC'
status: backlog
priority: medium
labels:
  - D34.2
  - D34.4
  - D34.6
  - main
  - migration
workstream: W22
workstreamId: W22-4
dependsOn:
  - 01M4J4B35HP3K6XKHRHTSTW6QA
  - 01M4J4AFF49PSQP3EGZSA2GW39
order: 30
created: '2026-10-10T05:25:11.177Z'
updated: '2026-10-10T05:25:11.177Z'
---
Spec: wiki `oscine-field-notes` → D34.2, D34.4, D34.6.

**Migration** — `recaps(year INTEGER PRIMARY KEY, generated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL, partial INTEGER NOT NULL, report TEXT NOT NULL)`. Mind the cross-branch `user_version` skew when numbering it.

**Classification** — add `recaps` to `src/main/bundle/tables.ts` as **carried** (self-contained, nothing machine-specific, not rebuildable). `tests/main/bundle/tables.test.ts` will fail until it is classified; that is the point.

**IPC** in `src/shared/ipc.ts`, `recap.*`:
- `list` → summaries (year, partial, generatedAt, source labels), no report bodies
- `get(year)` → the report, run through `upgradeRecapReport` on read
- `generate({ year, importFiles })` → the import files are chosen through a main-process dialog; main validates (W22-1), composes (W22-2), builds (W22-3), writes, closes the scratch connection. **Nothing about the import files is stored** (D34.2).
- `delete(year)`
- `existing(year)` → what a regenerate would replace, including the device sources it was built from, for the D34.4 warning

Generation is a long job: injectable deps, throttled progress, token cancel, on the `TagWritebackService` shape. Do not flood progress (the renderer-starvation lesson).

`partial` is true when the year is the host's current year at generation time.

**Tests:** generate → list → get round trip; regenerate replaces; `get` on a stored v1 report goes through the upgrader; cancel mid-generate leaves no row and no open scratch connection; the classification test passes.

**Done when:** a report can be generated with N imports, listed, read back and deleted entirely over IPC.
