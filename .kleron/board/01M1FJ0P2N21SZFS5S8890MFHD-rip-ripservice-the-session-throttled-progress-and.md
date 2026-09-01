---
taskId: 01M1FJ0P2N21SZFS5S8890MFHD
title: 'Rip: RipService — the session, throttled progress and token cancel'
status: backlog
priority: medium
labels:
  - cdrip
  - main
  - ipc
  - R10
workstream: W18
workstreamId: W18-5
dependsOn:
  - 01M1FHX2E9B7GSQRZHJ4MPFHX1
  - 01M1FHXZ4E3N5GWB3B3Y8AN5S0
  - 01M1FHYVP8XP027FVE6G79AS1D
  - 01M1FHZQC8BQQS72DA3PNR8HAP
order: 19
created: '2026-09-01T22:39:10.420Z'
updated: '2026-09-01T22:39:10.420Z'
---
## Intent

The orchestrator: drive → sectors → encoder → tags → temp file, one track at a time, with progress
the renderer can render and a cancel that actually stops. This is the card where W18-1..4 become a
feature.

## Model it on TagWritebackService, deliberately

`src/main/library/writeback/service.ts` is the proven shape for a long main-process job in this app
and there is no reason to invent a second one. Copy the properties, not the code:

- **Injectable deps** — `{ drive, lookup, encoder, resolvePath, now?, throttleMs? }` so the whole
  service is testable against a fake disc with no hardware and no encoder binary.
- **Throttled progress**, default 50 ms, coalesced in the service. This is not an optimisation, it
  is the fix for a known failure mode in this codebase: unthrottled IPC progress starves the
  renderer and the first symptom is a Cancel button that appears frozen. A rip emits progress per
  sector chunk — that is thousands of events per track if left unthrottled.
- **Token cancel** — `private inFlight: { aborted: boolean } | null`, checked between chunks, not
  only between tracks. A per-track check means Cancel takes up to five minutes to be observed.

## Order of operations per track

1. Read sectors for the track's range, **gaps appended to the preceding track** (the settled MVP
   convention): a track's sector range runs to the start of the next track, so the pregap belongs
   to the track before it. There is no special case; it falls out of using consecutive TOC offsets.
2. Stream PCM into the encoder, writing to `<dest>.<random>.part` in the destination directory —
   same directory so the later rename is same-device.
3. Apply tags via W16's `writer.ts`.
4. Hand the finished temp path to W18-7 for the atomic rename and reconcile.

**Skip data tracks silently** — filter `isAudio` out of the TOC here. The TOC carried them so the
disc ID would be right; nothing below this point should ever see one.

## Verify pass (R10)

Optional, off by default, settings-gated: rip each track twice and compare SHA-256 of the decoded
PCM. Mismatch marks the track `verify-failed` in the report, keeps the file, and says which track
and which sector range disagreed. This is the only mitigation the MVP has for burst-mode read
errors, so its **reporting** matters as much as its detection — a silent verify failure is worse
than no verify.

Doubling rip time is the honest cost and the setting's description should say so.

## Failure isolation

One track's failure never aborts the batch, exactly as write-back does it. A disc with one
unreadable track should yield eleven good files and one clearly reported failure, not nothing.

## Contract

`src/shared/cdrip.ts`:

- `RipTrackSelection { number: number; title: string; artist: string }`
- `RipRequest { driveId: string; rootId: number; relDir: string; template: string; tracks:
  RipTrackSelection[]; album: string; albumArtist: string; year: number | null; verify: boolean;
  onCollision: 'skip' | 'overwrite' | 'suffix' }`
- `RipProgress { trackNumber: number; trackIndex: number; trackCount: number; phase: 'reading' |
  'encoding' | 'tagging' | 'verifying'; sectorsDone: number; sectorsTotal: number }`
- `RipOutcome { trackNumber: number; status: 'written' | 'skipped' | 'failed' | 'verify-failed';
  relPath?: string; code?: RipFailureCode }`
- `RipReport { total: number; written: number; skipped: number; failed: number; cancelled: boolean;
  outcomes: RipOutcome[] }`

IPC channels in `src/shared/ipc.ts` (new surface starts there, never in a handler): start, cancel,
progress event, plus drive-list and TOC-read for W18-6.

## Files

- `src/main/cdrip/service.ts` — `RipService`
- `src/main/ipc/cdrip.ts` — handler registration and the `webContents` progress send
- `src/shared/ipc.ts` and `src/shared/cdrip.ts` — channel names and types

## Tests

All against a **fake drive** returning synthesised PCM, so CI needs no hardware:

- A clean twelve-track rip produces twelve outcomes and the right paths.
- Cancel mid-track is observed within one chunk and the report says `cancelled: true`.
- A single failing track leaves the other eleven `written`.
- Data tracks never reach the encoder.
- Gap sectors land on the preceding track (assert sector counts against a TOC with a known pregap).
- Verify-pass mismatch is detected and reported without deleting the file.
- Progress is coalesced: assert the emit count over a synthetic rip is bounded by elapsed time /
  `throttleMs`, not by chunk count. This is the regression test for the frozen-Cancel failure mode.

## Out of scope

No UI. No persistence or resume (W18-8). No indexing — W18-7 owns the handoff to the library.
