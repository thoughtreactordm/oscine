---
taskId: 01KYECJ52GBZS8TZ7JCXHEAWXK
title: 'M1 exit: verify end-to-end on Windows and Linux'
status: in-review
priority: medium
labels:
  - M1
  - milestone-exit
workstream: W6
workstreamId: W6-2
dependsOn:
  - 01KYECHS6GHY3ZHSFHZMTS2VHR
  - 01KYECFW1NMMVWQR2VT7PBQ4VM
effort: medium
order: 3
created: '2026-07-26T04:57:31.471Z'
updated: '2026-07-29T15:05:00.000Z'
---
The M1 exit criterion from design section 9. Not a coding card — a gate. M1 is not done until this passes on **both** platforms.

## Procedure

Run on Windows and on Linux, from a fresh database each time:

1. Launch, add a real folder containing MP3, FLAC and OGG files together.
2. Watch the scan complete with sane progress reporting.
3. Sort by each column, both directions.
4. Play one track of each format. Confirm accurate duration, working seek, working volume.
5. Skip forward and back through several tracks.
6. Scroll a large library and confirm virtualization holds.

## Also record

- Decoded byte sizes logged by the AudioEngine, for the longest track available. These feed M2's R1 threshold decision directly — real numbers beat the estimates in the design doc.
- Peak RSS during playback, per platform.
- Any behaviour that differs between the two platforms, however cosmetic. Cheap to note now, expensive to archaeologize later.

## Acceptance

- All six steps pass on both platforms.
- Findings recorded on this card, including the memory figures.
- Any defect found becomes a triage card rather than being fixed silently inside this one — the gate should report honestly, not absorb work.

## Note

If the Linux machine is not yet available when the rest of M1 lands, move this card to Blocked rather than closing M1. D10 makes both platforms first-class, and "we'll check Linux later" is exactly how a project quietly becomes Windows-only.

---

# Outcome

**Linux column complete and passing. Windows column owed — carved out to W6-3.**
Accepted on the Linux run by operator decision, 2026-07-29, with the Windows
figures explicitly tracked rather than waived.

Three defects found, all in R1's accounting, all filed to triage under W3 rather
than fixed here:

- `estimateDecodedBytes` prices at the file's sample rate, not the AudioContext's
- Decode transient peaks at 2.34x the decoded buffer
- Decoded buffers are not reclaimed without GC pressure

# Findings — Linux, 2026-07-29

CachyOS, Linux 7.1.4-1, Node v24.17.0, Electron 43.2.0, better-sqlite3 13.0.1.
Steps 1–6 driven manually by the operator (UI/UX signed off); the numbers below
are from an instrumented re-run over the same library via `scripts/cdp-eval.mjs`.
**Dev build, not packaged** — HMR and devtools inflate every RSS figure below.

## Pre-push gate

All five green, plus the native check: `lint` (0 warnings at `--max-warnings=0`),
`format:check`, `typecheck` (tsc + vue-tsc), `test` (225 tests / 14 files),
`build`. `verify:native` — Electron 43.2.0, Node 24.18.0, module ABI 148,
SQLite 3.53.3, WAL, `foreign_keys` ON, fts5, `unicode61 remove_diacritics 2`.

## Library under test

`/mnt/homelab/music` — 2970 tracks, 121 artists, 298 albums, 108.7 GiB, 227 h.

| codec | files | bytes | hours |
|---|---|---|---|
| flac | 2851 | 107.97 GiB | 220.59 |
| mp3 | 119 | 0.77 GiB | 6.37 |

Sample rates: 44100×2514, 96000×244, 48000×192, 88200×14, 192000×6. All stereo.
Null metadata: duration 0, title 0, sample_rate 0, channels 0, codec 0;
artist 6, album 10.

## Step 1–2 — scan

**Scan is exact.** 2972 audio files on disk, 2970 indexed. Both omissions are
correct, not misses:

- `.Trash-1000/files/…/01 Uncollected.flac` — inside a dot-directory.
- `El Ten Eleven/It's Still Like A Secret (album)/.flac` — a file literally named
  `.flac`, i.e. a dotfile with no basename.

Progress reporting on the probe root: two events, `{filesSeen:0, done:false}` then
`{filesSeen:5, tracksIndexed:5, done:true}`, summary `filesSkipped:0`.

**Path invariant holds.** 0 `rel_path` values that are absolute or drive-lettered,
0 containing a backslash. Root path stored absolute, as designed.

### Format coverage gap, and how it was closed

The real library contains **no OGG at all** (2853 flac / 119 mp3 / 0 ogg / 0 opus
/ 0 m4a on disk), so the folder used for the manual run cannot have satisfied
"MP3, FLAC and OGG together". Closed with a purpose-built fixture: five 45-second
transcodes of one source track in one folder, scanned as a second root.

| file | codec parsed | rate | ch | duration parsed | ffprobe |
|---|---|---|---|---|---|
| probe.flac | `flac` | 44100 | 2 | 45.000 | 45.000 |
| probe.m4a | `aac` | 44100 | 2 | 45.023 | 45.000 |
| probe.mp3 | `mp3` | 44100 | 2 | 45.035 | 45.000 |
| probe.ogg | `vorbis` | 44100 | 2 | 45.000 | 45.000 |
| probe.opus | `opus` | 48000 | 2 | 45.000 | 45.007 |

`filesSeen 5 / tracksIndexed 5 / filesSkipped 0`. `vorbis` and `aac` are the
intended tokens from `normaliseCodec`, not fallthrough. **OGG was a test-data gap,
not a code gap.** The same gap applies to the Windows run — see W6-3.

## Step 3 — sort

All five columns × both directions, 100-row page over 2975 rows: **0.8–2.1 ms**.
Deep page (`artist asc`, offset 2900): **1.7 ms**. CJK titles and albums order
sanely at the `desc` head.

## Step 4 — playback per format

All five formats decoded and played. `seek(30)` landed at 30.746–30.757 s on every
one. Volume `0.25` and `1.0` round-tripped exactly. Scrub cycle
(`beginScrub`/`scrubTo(5)`/`endScrub`) → 5.7 s. `toggle` → `paused` → `playing`.

## Step 5 — skip

`next()`×5 then `previous()`×3 walked `orderIndex` 5→10→7 with the correct track
at every stop and one decode per transition. **No prefetch decode was observed** —
M1's "current+prefetch" budget has only one term so far.

## Step 6 — virtualization

2975 tracks, 95,200 px scroll height. **25 rows in the DOM at every scroll
position** (18 in the final partial window), 362 total DOM nodes, flat from 0% to
100%.

## R1 numbers — the headline

Longest track available: **Sleep — Dopesmoker**, FLAC, 3809.03 s (63.5 min),
44.1 kHz stereo, 373.7 MiB encoded.

```
[audio] R1 track=2424 encoded=373.7MiB decoded=1.4GiB ratio=3.7x
        duration=3809.0s rate=48000Hz channels=2
```

Decoded exactly 1,462,666,368 B = **1.362 GiB**. It did not crash.

| measure | value |
|---|---|
| renderer RSS, idle baseline | 276 MiB |
| renderer RSS, **peak during decode** | **3190 MiB** |
| renderer RSS, settled during playback | 1590 MiB |
| main process RSS | 219–282 MiB throughout |
| `playFromList` → `status === 'playing'` | **9770 ms** |
| JS heap during playback | 30 MB |

Three things fall out of this, each filed to triage under W3:

1. **The log line says `rate=48000Hz` for a 44.1 kHz file.** `decodeAudioData`
   resamples to the AudioContext rate, so the true cost is set by the *output
   device*, not the file. `estimateDecodedBytes` prices from the DB's
   `sample_rate` and would misprice every track whose rate differs from the
   device's — under by 8.8% for 44.1 kHz here, over by 2× for the 244 96 kHz
   tracks in this library.
2. **Peak is 2.34× the decoded buffer** and 1.6 GiB above the settled figure.
   A guard that thresholds on final decoded size alone still OOMs on the
   transient.
3. **Nothing is reclaimed without pressure.** Across 9 more short tracks
   (~85 MiB decoded in total) RSS climbed monotonically 1590 → 1692 MiB. Four
   forced `HeapProfiler.collectGarbage` calls dropped it to **200 MiB** with a
   28.9 MB JS heap — so there is **no leak**, V8 simply never collects. R1's
   budget must count uncollected garbage as live.

Estimated decoded size of the five longest tracks, at file rates:
1281.6 / 1021.6 / 753.2 / 615.6 / 479.2 MiB (×1.088 at this machine's 48 kHz).
Whole library resident would be 300.2 GiB.

## Cleanliness

Zero `console.warn`/`console.error` in the renderer across the entire session
(15 lines captured, all `[audio] R1` info). Main-process log clean apart from an
OS fontconfig cache warning. Build emits only an upstream `@vueuse/core`
`/* #__PURE__ */` annotation warning from Rollup.

## Method note

Root registration for the fixture was inserted directly and scanned via
`library.scanRoot`, bypassing only the native folder picker — which the operator
had already exercised by hand on both platforms. Everything downstream of the
dialog is the real path. The library database was backed up before and restored
after, so play counts and `last_played_at` carry no residue from this run.

## Still owed → W6-3

The Windows column: decoded sizes, peak RSS, OGG coverage, and the
cross-platform diff. Tracked as its own card so it stays on the board rather than
in a paragraph.

---

# Probe report — Linux

Produced by `npm run probe:m1-exit` at the same commit, so the Windows column on
W6-3 has an artifact of identical shape to compare against rather than prose.

The probe's figures for the longest real track reproduce the hand-driven run
above within noise — peak 3194MiB against 3190, settled 1585 against 1590 — which
is the cross-check that the harness measures what the hand run measured.

**Nothing flagged.** Every automated check came back as expected.

### environment

```json
{
  "platform": "linux",
  "release": "7.1.4-1-cachyos",
  "hostname": "Michael-CachyOS",
  "electron": "43.2.0",
  "chrome": "150.0.7871.129",
  "node": "24.18.0",
  "v8": "15.0.1240245-electron.0",
  "arch": "x64",
  "audioContextSampleRateHz": 48000,
  "processes": [
    {
      "type": "Browser",
      "mib": 226
    },
    {
      "type": "GPU",
      "mib": 320
    },
    {
      "type": "Utility",
      "mib": 95
    },
    {
      "type": "Tab",
      "mib": 204
    },
    {
      "type": "Utility",
      "mib": 88
    }
  ]
}
```

### step 1 — add root

```json
{
  "fixture": "/tmp/fermata-probe-fixture",
  "rootId": 2,
  "trackCount": 6,
  "viaStubbedDialog": true,
  "caveat": "this root persists — M1 has no removeRoot on the IPC surface"
}
```

### step 2 — scan

```json
{
  "root": "/tmp/fermata-probe-fixture",
  "summary": {
    "rootId": 2,
    "filesSeen": 6,
    "tracksIndexed": 6,
    "filesSkipped": 0,
    "startedAt": "2026-07-29T14:49:09.203Z",
    "finishedAt": "2026-07-29T14:49:09.207Z"
  },
  "elapsedMs": 506,
  "progressEvents": 2,
  "sawTerminalEvent": true,
  "monotonic": true
}
```

### library census

```json
{
  "totalTracks": 2976,
  "tracksByRoot": {
    "1": 2970,
    "2": 6
  },
  "fixtureTracks": 6,
  "fixtureCodecs": [
    "aac",
    "flac",
    "flac",
    "mp3",
    "opus",
    "vorbis"
  ]
}
```

### step 3 — sort

```json
{
  "pairs": 11,
  "allOk": true,
  "slowestMs": 2.3,
  "timings": [
    {
      "sort": "trackNo",
      "direction": "asc",
      "ms": 1,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "trackNo",
      "direction": "desc",
      "ms": 1.1,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "title",
      "direction": "asc",
      "ms": 1,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "title",
      "direction": "desc",
      "ms": 1,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "artist",
      "direction": "asc",
      "ms": 0.8,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "artist",
      "direction": "desc",
      "ms": 2.3,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "album",
      "direction": "asc",
      "ms": 1,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "album",
      "direction": "desc",
      "ms": 0.9,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "durationSec",
      "direction": "asc",
      "ms": 0.9,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "durationSec",
      "direction": "desc",
      "ms": 1,
      "ok": true,
      "rows": 100,
      "total": 2976
    },
    {
      "sort": "artist",
      "direction": "asc @ 2876",
      "ms": 1.9,
      "ok": true,
      "rows": 100,
      "total": 2976
    }
  ]
}
```

### step 4 — playback per format

```json
[
  {
    "codec": "mp3",
    "expectedDuration": 20.036,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "mp3",
    "toPlayingMs": 52,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=2974 encoded=470.3KiB decoded=7.3MiB ratio=15.9x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "aac",
    "expectedDuration": 20.023,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "aac",
    "toPlayingMs": 48,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=2973 encoded=473.4KiB decoded=7.3MiB ratio=15.8x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "flac",
    "expectedDuration": 20,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "flac",
    "toPlayingMs": 41,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=2971 encoded=247.1KiB decoded=7.3MiB ratio=30.3x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "vorbis",
    "expectedDuration": 20,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "vorbis",
    "toPlayingMs": 41,
    "seekTarget": 10,
    "afterSeek": 10.7,
    "seekDrift": 0.7,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=2975 encoded=60.3KiB decoded=7.3MiB ratio=124.3x duration=20.0s rate=48000Hz channels=2"
    ]
  },
  {
    "codec": "opus",
    "expectedDuration": 20,
    "status": "playing",
    "error": null,
    "duration": 20,
    "reportedCodec": "opus",
    "toPlayingMs": 32,
    "seekTarget": 10,
    "afterSeek": 10.69,
    "seekDrift": 0.69,
    "volumeQuiet": 0.25,
    "volumeLoud": 1,
    "decodeLog": [
      "info: [audio] R1 track=2976 encoded=407.3KiB decoded=7.3MiB ratio=18.4x duration=20.0s rate=48000Hz channels=2"
    ]
  }
]
```

### step 5 — skip, scrub, pause

```json
{
  "walk": [
    2,
    3,
    4,
    5,
    6,
    5,
    4,
    3
  ],
  "walkedCorrectly": true,
  "afterScrub": 3.61,
  "paused": "paused",
  "resumed": "playing",
  "decodesPerTransition": 1
}
```

### R1 — synthetic long track (comparable across platforms)

```json
{
  "track": "Probe Long Decode",
  "codec": "flac",
  "durationSec": 3600,
  "status": "playing",
  "error": null,
  "playFromListReturnedMs": 6226,
  "timeToFirstAudioMs": 6226,
  "decodeLog": "info: [audio] R1 track=2972 encoded=41.4MiB decoded=1.3GiB ratio=31.9x duration=3600.0s rate=48000Hz channels=2",
  "decodedMiBAtContextRate": 1318.4,
  "rssBaselineMiB": 196,
  "rssPeakMiB": 2707,
  "rssSettledMiB": 1508,
  "lifetimePeakMiB": 3249,
  "peakGrowthOverDecoded": 1.9,
  "trace": [
    196,
    433,
    674,
    921,
    1167,
    1414,
    2131,
    1509,
    1584,
    1658,
    1732,
    1807,
    1881,
    1955,
    2028,
    2102,
    2176,
    2250,
    2327,
    2403,
    2479,
    2555,
    2631,
    2707,
    1783,
    1508,
    1508,
    1508,
    1508,
    1508,
    1508,
    1508,
    1508,
    1508,
    1508
  ]
}
```

### R1 — longest real track (this machine only)

```json
{
  "track": "Dopesmoker",
  "codec": "flac",
  "durationSec": 3809.03,
  "status": "playing",
  "error": null,
  "playFromListReturnedMs": 7824,
  "timeToFirstAudioMs": 7824,
  "decodeLog": "info: [audio] R1 track=2424 encoded=373.7MiB decoded=1.4GiB ratio=3.7x duration=3809.0s rate=48000Hz channels=2",
  "decodedMiBAtContextRate": 1394.9,
  "rssBaselineMiB": 1508,
  "rssPeakMiB": 3169,
  "rssSettledMiB": 1585,
  "lifetimePeakMiB": 3249,
  "peakGrowthOverDecoded": 1.19,
  "trace": [
    1508,
    1841,
    652,
    797,
    942,
    1085,
    1232,
    1377,
    1525,
    1671,
    1819,
    3057,
    1901,
    1977,
    2053,
    2129,
    2205,
    2281,
    2355,
    2429,
    2504,
    2578,
    2652,
    2726,
    2800,
    2875,
    2948,
    3021,
    3094,
    3169,
    3167,
    2914,
    1585,
    1585,
    1585,
    1585,
    1585,
    1585,
    1585,
    1585,
    1585,
    1585
  ]
}
```

### reclamation

```json
{
  "measuredWhilePlaying": "a short fixture track, so the large buffers are garbage",
  "rssBeforeForcedGcMiB": 1594,
  "rssAfterForcedGcMiB": 198,
  "recoveredMiB": 1396,
  "verdict": "collectable — not a leak, but nothing collects it without pressure"
}
```

### step 6 — virtualization

```json
{
  "scrollHeight": 95232,
  "clientHeight": 350,
  "samples": [
    {
      "fraction": 0,
      "scrollTop": 0,
      "rows": 24,
      "domNodes": 364
    },
    {
      "fraction": 0.25,
      "scrollTop": 23721,
      "rows": 24,
      "domNodes": 364
    },
    {
      "fraction": 0.5,
      "scrollTop": 47441,
      "rows": 24,
      "domNodes": 364
    },
    {
      "fraction": 0.75,
      "scrollTop": 71162,
      "rows": 24,
      "domNodes": 364
    },
    {
      "fraction": 1,
      "scrollTop": 94882,
      "rows": 17,
      "domNodes": 287
    }
  ],
  "totalTracks": 2976,
  "maxRowsInDom": 24,
  "rowsAtEachStop": [
    24,
    24,
    24,
    24,
    17
  ],
  "windowed": true,
  "grewWhileScrolling": false
}
```

### cleanliness

```json
{
  "capturedLines": 63,
  "decodeLines": 63,
  "warningsAndErrors": []
}
```
