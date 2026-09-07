---
taskId: 01M1FHX2E9B7GSQRZHJ4MPFHX1
title: 'Rip: the optical drive addon — TOC and audio sector reads'
status: backlog
priority: high
labels:
  - cdrip
  - native
  - addon
  - spike
  - R9
workstream: W18
workstreamId: W18-1
order: 15
created: '2026-09-01T22:37:12.009Z'
updated: '2026-09-01T22:37:12.009Z'
---
## Intent

The foundation card and the only genuinely hard one in the stream: an N-API addon that enumerates
optical drives, reads a disc's table of contents, and reads raw CDDA sectors. Everything else in
W18 is ordinary application code sitting on top of it. No encoding, no metadata, no UI, no IPC —
this card ends at a tested native module with a TypeScript interface.

**Run this as a spike before it is an implementation.** If SCSI pass-through turns out to be a
swamp on either platform, the shape of the whole stream changes, and that is worth knowing in the
first week rather than the fifth. Nothing downstream should be started until the spike returns.

## Why native, and why not the alternatives

There is no Node or Electron API for CDDA, and nothing in the tree touches optical media today.
Three routes were considered:

- **libcdio bindings** — rejected. A GPL/LGPL build dependency plus a cross-compilation problem,
  imported to obtain a command set that is a few hundred lines of C++ direct.
- **`ffmpeg -i cdda:`** — rejected. Prebuilt static ffmpeg distributions are not compiled with
  libcdio, so the `cdda:` demuxer is simply absent from any binary we would ship.
- **`cdparanoia` as a subprocess** — rejected on contact. There is no Windows peer, which fails
  D10 before any other property is evaluated.

Direct MMC pass-through wins because **both platforms speak the same command set**. `READ
TOC/PMA/ATIP` (0x43) and `READ CD` (0xBE) are identical CDBs; only the delivery differs. That makes
the platform split a thin ioctl wrapper at the bottom of one file rather than two implementations
of a feature.

## Contract

`src/shared/cdrip.ts` — the cross-process types (per the `src/shared` convention):

- `CdDriveInfo { id: string; label: string; vendor: string; product: string }` — `id` is the
  opaque device handle string the addon accepts back; the renderer never interprets it.
- `CdTocEntry { number: number; startSector: number; sectorCount: number; isAudio: boolean;
  preEmphasis: boolean }`
- `CdToc { entries: CdTocEntry[]; leadOutSector: number; firstTrack: number; lastTrack: number }` —
  entries include data tracks with `isAudio: false` so the disc ID computation in W18-2 sees the
  true TOC; **filtering to audio-only is the caller's job, not the addon's.**
- `CdReadError = 'no-disc' | 'not-audio' | 'device-busy' | 'read-failed' | 'unsupported-drive'`

The addon's own surface (main-process only, never reaches the renderer):

- `listDrives(): CdDriveInfo[]`
- `readToc(driveId: string): CdToc`
- `readSectors(driveId: string, startSector: number, count: number): { pcm: Buffer; c2: Buffer |
  null }` — returns 2352 bytes/sector of little-endian signed 16-bit stereo, plus the 294-byte C2
  error-pointer block per sector when the drive supplies it.

Reads are **synchronous inside a libuv worker**, exposed as a promise. A rip must never block the
main thread; a `READ CD` on a marginal sector can take seconds.

## Platform backends

One interface, two files, difference confined below the interface (D10):

- **Linux** — `SG_IO` ioctl on `/dev/sr*`. Enumerate by scanning `/dev/disk/by-path` for `*-cd`
  links rather than assuming `sr0`.
- **Windows** — `IOCTL_SCSI_PASS_THROUGH_DIRECT` on `\\.\<letter>:`. Enumerate with
  `GetLogicalDrives` filtered by `GetDriveType == DRIVE_CDROM`.

Nothing above the backend files may branch on platform. `oscine/no-windows-path-literals` does not
police C++, so the device-path construction is reviewed by hand — the Windows device path is a
genuine backslash literal and it belongs only in the Windows backend.

## Read strategy (R10)

Burst mode: sequential `READ CD` in multi-sector chunks, honouring C2 error pointers where the
drive reports them. On a failed sector, retry N times before surfacing `read-failed` with the
sector number so the caller can report *which track* is damaged.

Explicitly **not** in scope: cdparanoia-class jitter correction and read-offset correction. The
double-pass hash comparison that partially compensates is W18-5's, not this card's. Record in a
comment that R10 is accepted here and mitigated there.

## Packaging

This is a fourth native dependency alongside `better-sqlite3`, `sharp` and `node-web-audio-api`,
so it inherits their discipline rather than inventing new: prebuilds per platform, wired into
`npm run verify:native`, and it must not break `npm run pack`. Confirm the ABI story against the
current Electron before writing the binding — the existing `verify:native` gate exists precisely
because this class of dependency drifts.

## Files

- `native/cdrip/` — binding.gyp, `cdrip.cc` (N-API surface), `mmc.cc` (CDB construction, shared),
  `backend_linux.cc`, `backend_win.cc`
- `src/shared/cdrip.ts` — the types above
- `src/main/cdrip/drive.ts` — the typed wrapper the rest of main imports, with the addon behind an
  interface so tests can inject a fake disc

## Tests

The addon itself cannot be unit-tested in CI — there is no disc in a GitHub runner. So:

- **Vitest** covers the pure parts on a recorded TOC response buffer: CDB construction, TOC
  response parsing (including a mixed-mode disc with a trailing data track), MSF/LBA conversion,
  and the `CdReadError` mapping. Check in the captured response bytes as fixtures.
- **`src/main/cdrip/drive.ts` is tested against a fake**, so every downstream card can be developed
  and tested with no hardware at all. This is the property that keeps W18-2..W18-8 CI-testable.
- **Hardware verification is a human-verify triage card**, not a CI job: at minimum one pressed
  disc, one CD-R and one mixed-mode/enhanced disc, on both platforms, on at least two drives. R9
  says drives disagree; a single drive proves nothing.

## Out of scope

No encoding, no metadata lookup, no file writing, no IPC surface, no UI. Data tracks are reported
in the TOC but never read.
