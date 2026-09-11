# W18-1 optical addon spike

## Result — 2026-09-08

The Linux pass-through spike succeeds on **HL-DT-ST BD-RE BP50NB40, firmware 1.03,
USB**, using the user-supplied seven-track audio CD. Its pressing type was not
verified. The Windows backend is implemented but has not been compiled or run on
Windows in this session. **This is not the cross-platform R9 exit gate.** Keep
W18-2 onward gated on the hardware matrix in W18-9; do not treat a single successful
drive as evidence that the stream is cleared.

Observed results:

- Empty drive enumerated with vendor/model and rejected TOC with `no-disc`.
- With media inserted, format-0 TOC returned seven audio tracks, first LBA 33,
  last-track LBA 149488 and lead-out 169995. Nonzero first-track LBA is preserved.
- Captured LBA and MSF responses are checked in under
  `tests/main/cdrip/fixtures/captured-{lba,msf}.json`. Commands were
  `43 00 00 00 00 00 00 03 24 00` and `43 02 00 00 00 00 00 03 24 00`, respectively,
  with an 804-byte allocation; only the declared response length is retained.
- GET CONFIGURATION returned `0000000c00000008001e090403000000` for CD Read.
  This exposed and corrected a C2 feature-byte indexing error during the spike.
- LBA 783, count 32 returned **75,264 PCM bytes + 9,408 C2 bytes**, no pointers set.
  PCM SHA-256: `2f564b65443a59b5bc41ba58411a3382ac141b7d767b28108be19af4a1d2ad36`.
  One run took 87 ms while the JavaScript interval ticked 82 times.
- The same packaged binary loaded under **Electron 43.2.0 / Node 24.18.0 / ABI 148**
  and read the same TOC and byte counts. It was built against system Node 24.17.0
  (ABI 137). `npm run verify:native` also verifies loading and async rejection
  without requiring media.
- `npm run pack` produced the Linux unpacked app with the addon in
  `app.asar.unpacked/node_modules/@oscine/cdrip/prebuilds/linux-x64/cdrip.node`.
- Lint, formatting, typecheck, build and the full test suite passed. An initial
  run alongside packaging exceeded two existing library performance budgets;
  the full suite passed when rerun without competing build work.

This proves transport, TOC parsing, C2 transfer shape, runtime loading and worker
scheduling on one drive. It does not prove sample accuracy, jitter correction,
read offsets, damaged-disc recovery on hardware, or C2 reporting reliability.
The mixed-mode fixture is explicitly **synthetic**, not a claimed hardware capture.
A captured mixed-mode disc remains part of W18-9.

## API and build

Cross-process value types are in `src/shared/cdrip.ts`. Main consumers inject the
`CdDrive` interface from `src/main/cdrip/drive.ts`, or call `createCdDrive()` for
lazy native loading. All three operations return promises:

```ts
const drive = createCdDrive()
const [device] = await drive.listDrives()
const toc = await drive.readToc(device.id)
const track = toc.entries.find((entry) => entry.isAudio)
if (track) {
  const { pcm, c2 } = await drive.readSectors(device.id, track.startSector, 32)
}
```

`pcm` is signed 16-bit little-endian stereo at 44.1 kHz, 2352 bytes per sector.
`c2` is 294 bytes per sector or `null` when unavailable. It is never fabricated
when unsupported. Consumers receive `CdDriveError` with one of the five shared
codes and an optional failed `sector`; `cause` retains the original native error.
Argument failures are also converted into rejected promises by the wrapper.

`npm ci` invokes `build:cdrip` through postinstall. Developers and CI need Python,
Node headers and a C++17 toolchain (GCC/make on Linux; Visual Studio C++ tools and
Windows SDK on Windows). There is no libcdio dependency. Build output is copied
to `native/cdrip/prebuilds/<platform>-<arch>/cdrip.node`; the local production
package `@oscine/cdrip` loads that prebuild. The Python/Node build tools are
**dev dependencies**, not runtime dependencies. Each platform builds its own
binary before packaging; electron-builder keeps `npmRebuild: false`. The new
addon does not require rebuilding any existing native dependency.

Useful commands:

```sh
npm run build:cdrip
npx vitest run tests/main/cdrip
npm run verify:native
npm run probe:cdrip                 # first enumerated drive, read-only
npm run probe:cdrip -- '<drive id>'  # choose a listDrives() identity
npm run pack
```

The probe prints the TOC and a short-read hash; it writes no audio or library
state. The addon has a private `_test` seam that exercises the compiled MMC core
against scripted responses without opening devices. Production callers should
use the typed wrapper; `_test` is not part of the application contract.

## Deliberate boundaries and findings

- Linux scans `/dev/disk/by-path` and deduplicates canonical optical targets.
  This machine's USB links have **no `-cd` suffix**; insisting on the suffix
  would miss the available drive. Sysfs optical entries provide a fallback
  where by-path links are absent. IDs still name only validated `/dev/sr*`
  optical block devices; arbitrary files are rejected.
- Windows uses optical drive letters and `IOCTL_SCSI_PASS_THROUGH_DIRECT`, with
  adapter alignment queried before allocating the transfer buffer. Permissions
  and sharing failures map to `device-busy`, with the OS error retained in the
  message. Enumeration retains inaccessible drives with a fallback label.
- The shared layer requests CD-DA sector type explicitly and checks the TOC
  before reading. Data tracks remain in the TOC but data-track/lead-out crossings
  are rejected. Hidden negative-LBA audio and inter-session gap recovery are not
  implemented; an enhanced disc must pass the hardware gate.
- Calls accept 1–450 sectors and issue chunks of at most 16. C2-flagged or failed
  chunks fall back to individual sectors, each with an initial attempt and
  three retries. Persistent C2 flags cause `read-failed` with the exact LBA.
  Unit attention, removal, busy and unsupported commands do not loop as media
  errors. Each OS command has a 20-second timeout; total duration on bad media
  can exceed that. There is no cancellation API in this card.
- C2 is selected from the current CD Read feature. A missing/unsupported feature
  or rejection of the advertised C2 field uses a plain read with `c2: null`.
  Short audio transfers fail instead of padding PCM. Open handles are scoped to
  one worker operation. Concurrent calls with the same opaque ID reject busy.
- R10 remains accepted: no jitter or read-offset correction. W18-5's proposed
  double-pass comparison is downstream work, not implemented here.

## Protocol and ABI references

- [Node-API ABI stability and versioning](https://nodejs.org/api/n-api.html):
  the binding explicitly targets Node-API 8 and uses no V8/Node C++ APIs.
- [Microsoft SCSI pass-through requirements](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddscsi/ni-ntddscsi-ioctl_scsi_pass_through_direct):
  device-aligned buffers and returned transfer lengths.
- [Microsoft CD Read feature layout](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddmmc/ns-ntddmmc-_feature_data_cd_read):
  C2 capability is bit 1 of the first byte after the four-byte feature header.
- [Linux SG_IO interface](https://github.com/torvalds/linux/blob/master/include/scsi/sg.h):
  sense, transport status and residual transfer lengths.
