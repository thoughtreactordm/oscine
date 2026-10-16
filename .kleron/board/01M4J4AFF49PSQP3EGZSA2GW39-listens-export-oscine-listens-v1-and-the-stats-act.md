---
taskId: 01M4J4AFF49PSQP3EGZSA2GW39
title: Listens export — `oscine.listens` v1 and the Stats action
status: backlog
priority: medium
labels:
  - D34.1
  - main
  - shared
workstream: W22
workstreamId: W22-1
order: 27
created: '2026-10-10T05:24:40.035Z'
updated: '2026-10-10T05:24:40.035Z'
---
Spec: wiki `oscine-field-notes` → D34.1.

The file other devices hand to Field Notes. Also the listens section of W10-13's eventual D11 bundle, so the serializer and validator belong in `src/shared/`, not inside the recap module.

**Format** — gzipped JSON, `format: 'oscine.listens'`, `formatVersion: 1`, modelled on `src/shared/settings/profile.ts`.
- Header: `installId`, `deviceLabel`, `timeZone` (IANA), `exportedAt`, covered range, row count.
- Rows: `startedAt` (UTC ms), `msListened`, `durationMs`, `title`, `artistName`, `albumTitle`, `albumArtistName`, `genres: { key, name }[]`. **No `track_id`.**
- Always the whole log.

**Install ID** — new `durable`, `internal`, `portable: false` setting holding a random UUID, created on first read. Nothing in the tree has one today.

**Validator** — the file is untrusted input. Strict structure, string length caps, a file size cap, and a clear refusal of an unknown `format` or a newer `formatVersion`. Returns a typed result (parsed export | reason), never throws on bad input.

**Export** — IPC in `src/shared/ipc.ts`; main streams `listens` + `listen_genres` into the file through a save dialog. The device label defaults to hostname + platform and is editable before saving. Action: "Export listening history…" in the Stats view.

**Tests:** round trip (export → validate → identical rows); validator rejects truncated gzip, wrong format, newer version, oversize strings, missing fields; an empty log exports a valid file with zero rows.

**Done when:** a file exported on one install validates on another, and the validator is the only import entry point W22-2 uses.
