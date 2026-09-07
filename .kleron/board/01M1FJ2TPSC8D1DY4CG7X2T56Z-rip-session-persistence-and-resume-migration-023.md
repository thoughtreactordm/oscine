---
taskId: 01M1FJ2TPSC8D1DY4CG7X2T56Z
title: 'Rip: session persistence and resume (migration 023)'
status: backlog
priority: low
labels:
  - cdrip
  - schema
  - migration
  - durability
  - deferrable
workstream: W18
workstreamId: W18-8
dependsOn:
  - 01M1FJ0P2N21SZFS5S8890MFHD
  - 01M1FJ1A7514VX99VMCYXJ7PHC
order: 22
created: '2026-09-01T22:40:20.696Z'
updated: '2026-09-01T22:40:20.696Z'
---
## Intent

Make a rip survive a crash, a quit or a power cut. A full disc at compression level 5 is on the
order of ten minutes, and losing track 11 of 12 to a crash means starting over — with the disc
still in the drive and no memory of which tracks already landed.

## This card is deliberately last and deliberately deferrable

The stream is shippable without it: W18-1..7 rip a disc end to end. Durability is the difference
between "works" and "does not punish you when it doesn't", and that is a real difference, but it is
not what blocks a first usable version. **Schedule it after the pane, and be willing to cut it from
an MVP** — recorded here so cutting it is a decision rather than an omission.

## Schema — migration 023

Next migration number after `022-track-genres-album.ts`; confirm nothing has landed in between
before writing it.

- `rip_sessions` — `id`, `disc_id`, `toc_hash`, `release_mbid` (nullable), `root_id`, `rel_dir`,
  `template`, `album`, `album_artist`, `year`, `verify`, `state` (`running` | `cancelled` |
  `complete` | `failed`), `created_at`, `updated_at`
- `rip_session_tracks` — `session_id`, `track_number`, `title`, `artist`, `rel_path`, `status`
  (`pending` | `written` | `skipped` | `failed` | `verify-failed`), `sha256` (nullable),
  `attempts`, `error_code` (nullable)

`toc_hash` is what makes resume safe: on resume, re-read the TOC and **refuse to continue against a
different disc**. Resuming onto the wrong disc would interleave two albums into one folder, which
is the failure this column exists to prevent.

Rows are written **before** work, updated after — persist first, act second, the same ordering
`scrobble_outbox` uses under D19 and for the same reason. A row that says `pending` when the app
died is recoverable; a row written only on success is not.

Paths stored here are root-relative like everywhere else. The invariant has no exception for
bookkeeping tables.

## Resume

On app start, an unfinished `running` session is offered, not resumed automatically — the disc may
be gone, and silently spinning up a drive at launch is hostile. Offer it from the Rip pane: "Resume
ripping <album> — 4 of 12 tracks remaining."

Tracks already `written` are skipped. A `failed` track is retried. Cancelled sessions are kept for
the operator's reference, not resumed.

## Retention

Prune sessions older than 30 days on startup, and cap total rows — this is a log, not an archive,
and it should not be the table that grows without bound (the same R8-shaped mistake in a different
place).

## Files

- `src/main/db/migrations/023-rip-sessions.ts`
- `src/main/cdrip/sessionStore.ts`
- `src/main/cdrip/service.ts` — the write points
- `src/renderer/panels/tools/CdRipPane.vue` — the resume affordance

## Tests

- Migration applies cleanly on a fresh DB and on one at 022.
- A session interrupted after track 4 resumes at track 5 and does not re-rip 1–4.
- Resume against a **different disc is refused** by `toc_hash` mismatch, with a clear message.
- Rows exist in `pending` before the encoder runs (kill the fake encoder mid-track and assert the
  row is there).
- Pruning removes old sessions and leaves the running one alone.
- Stored paths are relative.

## Out of scope

No rip history UI beyond the resume prompt. No re-rip-from-history. No cross-machine session sync.
