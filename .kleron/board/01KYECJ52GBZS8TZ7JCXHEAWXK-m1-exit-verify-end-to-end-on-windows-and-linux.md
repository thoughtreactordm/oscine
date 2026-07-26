---
taskId: 01KYECJ52GBZS8TZ7JCXHEAWXK
title: 'M1 exit: verify end-to-end on Windows and Linux'
status: todo
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
order: 9
created: '2026-07-26T04:57:31.471Z'
updated: '2026-07-26T04:57:31.471Z'
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
