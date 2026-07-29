---
taskId: 01KYQ4RF3F54A0HB1P3NJPFVAD
title: 'M1 exit: Windows column — decoded sizes, peak RSS, and OGG coverage'
status: done
priority: medium
labels:
  - M1
  - milestone-exit
  - from-W6-2
workstream: W6
workstreamId: W6-3
dependsOn:
  - 01KYECJ52GBZS8TZ7JCXHEAWXK
order: 10
created: '2026-07-29T14:34:19.630Z'
updated: '2026-07-29T19:35:07.997Z'
---
Carved out of W6-2 so the outstanding half of the M1 exit gate stays visible
rather than living in a "still owed" paragraph. W6-2 recorded a full instrumented
Linux run and was accepted on that basis; this is the balance.

D10 makes both platforms first-class. W6-2's own closing note warns that "we'll
check X later" is how a project quietly becomes single-platform — this card is
the ledger entry that keeps that from happening in the other direction.

## Run it

The gate is a script now (`scripts/m1-exit-probe.mjs`), so the Windows column is
the *same experiment* as the Linux one rather than a second opinion. Three
commands, in a repo checked out at the commit W6-2 was run against or later:

```
npm run probe:fixture                                          # once per machine
npm run dev -- -- --remote-debugging-port=9222 --inspect=9229
npm run probe:m1-exit
```

The probe prints a per-step tick list, flags anything unexpected, and writes a
markdown report to `%TEMP%\m1-exit-win32.md`. Paste that report into this card
verbatim — it is the Windows column.

`probe:fixture` needs ffmpeg on PATH: `winget install Gyan.FFmpeg`. It synthesises
its own audio rather than transcoding anything, so the fixture is byte-comparable
with the Linux one.

Nothing in the probe is platform-conditional. Memory comes from Chromium's
`app.getAppMetrics()` over the main-process inspector rather than `/proc`; the
fixture is generated rather than scavenged; every path is composed. If it needs a
platform branch to run on Windows, that branch is itself a finding.

## What the probe covers, and what it does not

Covers steps 1–6 for behaviour and timing, both R1 measurements, reclamation, and
console cleanliness. It stubs `dialog.showOpenDialog` for exactly one call so
step 1 runs unattended — everything downstream of the human's click is the real
`addRoot` path.

It does not judge how any of it *looks*. The operator still signs off the UI, as
on Linux.

## What is being compared

1. **`audioContextSampleRateHz`** — the probe records it first, and it is the
   number the whole R1 mispricing card turns on. If the Windows machine runs at
   44.1 kHz rather than 48 kHz, the error in `estimateDecodedBytes` has the
   *opposite sign* there. A constant tuned on one platform would be wrong on the
   other.
2. **`peakGrowthOverDecoded`** — Linux measured 1.91 on the synthetic hour-long
   FLAC. WASAPI shared-mode resampling is not the same code as PipeWire's, so
   this is not assumed to transfer.
3. **`reclamation.recoveredMiB`** — Linux recovered 1397 MiB from a forced
   collection, which is what makes the finding "not a leak, just uncollected".
   V8's external-memory pressure heuristics are not identical across platforms.
4. **Step 4's codec table** — the first Linux run found the test library had no
   OGG at all, so the step had silently never run on *either* platform. The
   fixture closes it on both.

Linux reference figures for comparison live on W6-2.

## Acceptance

- Probe report pasted onto this card.
- Cross-platform diff written onto W6-2, however cosmetic the differences.
- The three R1 triage cards updated with their Windows figures, since all three
  say the Linux number should not be hardcoded until Windows confirms it.
- Any Windows-only defect becomes its own triage card, not a fix inside this one.

---

# Outcome

**Windows column complete and passing. Nothing flagged.** Run 2026-07-29 at
`0e11dff`, unmodified — the probe needed no platform branch to run, which was
itself one of the things under test.

**No Windows-only defect was found.** All four compared quantities transfer from
Linux within noise, the OGG gap is closed on both platforms, and the console is
clean. The three R1 triage cards have been updated with their Windows figures and
all three are now unblocked to hardcode the constants they were waiting on.

One defect *was* found, and it is not a platform defect — it is a **scale**
defect that this run was the first to be in a position to see, because this
machine's library carries the 100k synthetic root and the Linux machine's is
2,976 tracks. Filed as **W2-3 — "Every track transition pays a 50–125 ms
full-library sort query at 100k tracks"** (`01KYQMNRX95CN5DW6N6YYEZKC1`), not
fixed here.

## Caveat on the two libraries

The two runs used **different libraries**: Linux 2,976 tracks, Windows 102,997
(root 1 is the same 2,970-track collection on both, plus a 21-track root, plus a
100,000-track synthetic root and the 6-track fixture). Everything derived from
the fixture — the codec table, both R1 measurements, reclamation — is
byte-comparable and does compare platforms. **Sort timings, virtualization
figures and step 4's `toPlayingMs` do not**; they compare scale. Read them that
way and they are a bonus data point rather than a discrepancy: this is the first
measurement of the gate at the stated 100k target.

## Follow-up measurement, beyond what the probe records

Step 4's `toPlayingMs` came out 167–266 ms against Linux's 32–52 ms, which looked
like a 3–5x platform regression. It is not. Decomposed live in the renderer:

| stage | ms |
|---|---|
| `listTracks` index→track lookup (102,997 rows) | ~50 |
| `getTrackFileUrl` | 0.3 |
| `fetch` of the encoded bytes | 2.6 |
| `decodeAudioData` (20 s MP3) | 47–61 |

The ~50 ms is the library-size term, not a platform term, and the probe pays it
only because it calls `playFromList` **without** a `track` — the real UI passes
the row it already holds (`LibraryView.vue:49`) and takes the fast path at
`controller.ts:211`, skipping the lookup entirely. Residual platform difference
in decode itself is roughly 1.3x, not 5x.

That measurement is what turned into the W2 card above, because `next()` and
`previous()` have no such fast path.

---

# Probe report — Windows, verbatim

# M1 exit probe — win32

Host `DESKTOP-I9E6PNC` · 10.0.26200 · generated by `scripts/m1-exit-probe.mjs`.

**Nothing flagged.** Every automated check came back as expected.

## environment

```json
{
  "platform": "win32",
  "release": "10.0.26200",
  "hostname": "DESKTOP-I9E6PNC",
  "electron": "43.2.0",
  "chrome": "150.0.7871.129",
  "node": "24.18.0",
  "v8": "15.0.1240245-electron.0",
  "arch": "x64",
  "audioContextSampleRateHz": 48000,
  "processes": [
    { "type": "Browser", "mib": 115 },
    { "type": "GPU", "mib": 99 },
    { "type": "Utility", "mib": 49 },
    { "type": "Tab", "mib": 146 },
    { "type": "Utility", "mib": 79 }
  ]
}
```

## step 1 — add root

```json
{
  "fixture": "C:\\Users\\Michael\\AppData\\Local\\Temp\\fermata-probe-fixture",
  "rootId": 4,
  "trackCount": 6,
  "viaStubbedDialog": true,
  "caveat": "this root persists — M1 has no removeRoot on the IPC surface"
}
```

## step 2 — scan

```json
{
  "root": "C:\\Users\\Michael\\AppData\\Local\\Temp\\fermata-probe-fixture",
  "summary": {
    "rootId": 4,
    "filesSeen": 6,
    "tracksIndexed": 6,
    "filesSkipped": 0,
    "startedAt": "2026-07-29T19:06:42.993Z",
    "finishedAt": "2026-07-29T19:06:43.001Z"
  },
  "elapsedMs": 517,
  "progressEvents": 2,
  "sawTerminalEvent": true,
  "monotonic": true
}
```

## library census

```json
{
  "totalTracks": 102997,
  "tracksByRoot": { "1": 2970, "2": 21, "3": 100000, "4": 6 },
  "fixtureTracks": 6,
  "fixtureCodecs": ["aac", "flac", "flac", "mp3", "opus", "vorbis"]
}
```

## step 3 — sort

```json
{
  "pairs": 11,
  "allOk": true,
  "slowestMs": 123,
  "timings": [
    { "sort": "trackNo", "direction": "asc", "ms": 50.5, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "trackNo", "direction": "desc", "ms": 49.9, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "title", "direction": "asc", "ms": 50.5, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "title", "direction": "desc", "ms": 50.5, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "artist", "direction": "asc", "ms": 50, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "artist", "direction": "desc", "ms": 51.9, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "album", "direction": "asc", "ms": 49.9, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "album", "direction": "desc", "ms": 49.9, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "durationSec", "direction": "asc", "ms": 50.9, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "durationSec", "direction": "desc", "ms": 49.9, "ok": true, "rows": 100, "total": 102997 },
    { "sort": "artist", "direction": "asc @ 102897", "ms": 123, "ok": true, "rows": 100, "total": 102997 }
  ]
}
```

## step 4 — playback per format

```json
[
  {
    "codec": "mp3",
    "expectedDuration": 20.036,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "mp3",
    "toPlayingMs": 266,
    "seekTarget": 10,
    "afterSeek": 10.69,
    "seekDrift": 0.69,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=102995 encoded=470.3KiB decoded=7.3MiB ratio=15.9x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "aac",
    "expectedDuration": 20.023,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "aac",
    "toPlayingMs": 182,
    "seekTarget": 10,
    "afterSeek": 10.69,
    "seekDrift": 0.69,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=102994 encoded=473.4KiB decoded=7.3MiB ratio=15.8x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "flac",
    "expectedDuration": 20,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "flac",
    "toPlayingMs": 171,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=102992 encoded=247.1KiB decoded=7.3MiB ratio=30.3x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "vorbis",
    "expectedDuration": 20,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "vorbis",
    "toPlayingMs": 173,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=102996 encoded=60.3KiB decoded=7.3MiB ratio=124.3x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "opus",
    "expectedDuration": 20,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "opus",
    "toPlayingMs": 167,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=102997 encoded=407.3KiB decoded=7.3MiB ratio=18.4x duration=20.0s rate=48000Hz channels=2"
    ]
  }
]
```

## step 5 — skip, scrub, pause

```json
{
  "walk": [2, 3, 4, 5, 6, 5, 4, 3],
  "walkedCorrectly": true,
  "afterScrub": 3.59,
  "paused": "paused",
  "resumed": "playing",
  "decodesPerTransition": 1
}
```

## R1 — synthetic long track (comparable across platforms)

```json
{
  "track": "Probe Long Decode",
  "codec": "flac",
  "durationSec": 3600,
  "status": "playing",
  "error": null,
  "playFromListReturnedMs": 6011,
  "timeToFirstAudioMs": 6011,
  "decodeLog": "info: [audio] R1 track=102993 encoded=41.4MiB decoded=1.3GiB ratio=31.9x duration=3600.0s rate=48000Hz channels=2",
  "decodedMiBAtContextRate": 1318.4,
  "rssBaselineMiB": 148,
  "rssPeakMiB": 2717,
  "rssSettledMiB": 1468,
  "lifetimePeakMiB": 2788,
  "peakGrowthOverDecoded": 1.95,
  "trace": [
    148, 339, 590, 842, 1081, 1322, 2274, 1455, 1535, 1616, 1701, 1786, 1867,
    1948, 2028, 2113, 2198, 2279, 2359, 2440, 2525, 2611, 2696, 2717, 1468,
    1468, 1468, 1468, 1468, 1468, 1468, 1468, 1468, 1468
  ]
}
```

## R1 — longest real track (this machine only)

```json
{
  "track": "Dopesmoker",
  "codec": "flac",
  "durationSec": 3809.03,
  "status": "playing",
  "error": null,
  "playFromListReturnedMs": 8894,
  "timeToFirstAudioMs": 8894,
  "decodeLog": "info: [audio] R1 track=2491 encoded=373.7MiB decoded=1.4GiB ratio=3.7x duration=3809.0s rate=48000Hz channels=2",
  "decodedMiBAtContextRate": 1394.9,
  "rssBaselineMiB": 1466,
  "rssPeakMiB": 3181,
  "rssSettledMiB": 1547,
  "lifetimePeakMiB": 3205,
  "peakGrowthOverDecoded": 1.23,
  "trace": [
    1466, 1485, 1554, 1618, 1689, 1757, 1822, 598, 742, 884, 1032, 1172, 1312,
    1452, 1593, 1741, 2738, 1849, 1930, 2016, 2101, 2185, 2270, 2352, 2437,
    2518, 2604, 2685, 2767, 2848, 2934, 3014, 3100, 3181, 2652, 1547, 1547,
    1547, 1547, 1547, 1547, 1547, 1547, 1547, 1547
  ]
}
```

## reclamation

```json
{
  "measuredWhilePlaying": "a short fixture track, so the large buffers are garbage",
  "rssBeforeForcedGcMiB": 1557,
  "rssAfterForcedGcMiB": 159,
  "recoveredMiB": 1398,
  "verdict": "collectable — not a leak, but nothing collects it without pressure"
}
```

## step 6 — virtualization

```json
{
  "scrollHeight": 3295904,
  "clientHeight": 350,
  "samples": [
    { "fraction": 0, "scrollTop": 0, "rows": 24, "domNodes": 374 },
    { "fraction": 0.25, "scrollTop": 823889, "rows": 24, "domNodes": 374 },
    { "fraction": 0.5, "scrollTop": 1647777, "rows": 24, "domNodes": 374 },
    { "fraction": 0.75, "scrollTop": 2471666, "rows": 24, "domNodes": 374 },
    { "fraction": 1, "scrollTop": 3295554, "rows": 17, "domNodes": 297 }
  ],
  "totalTracks": 102997,
  "maxRowsInDom": 24,
  "rowsAtEachStop": [24, 24, 24, 24, 17],
  "windowed": true,
  "grewWhileScrolling": false
}
```

## cleanliness

```json
{ "capturedLines": 16, "decodeLines": 16, "warningsAndErrors": [] }
```
