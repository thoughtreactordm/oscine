---
taskId: 01KYQ4RF3F54A0HB1P3NJPFVAD
title: 'M1 exit: Windows column — decoded sizes, peak RSS, and OGG coverage'
status: todo
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
updated: '2026-07-29T14:51:33.781Z'
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
