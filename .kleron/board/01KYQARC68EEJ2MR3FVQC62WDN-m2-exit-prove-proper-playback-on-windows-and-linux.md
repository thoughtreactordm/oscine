---
taskId: 01KYQARC68EEJ2MR3FVQC62WDN
title: 'M2 exit: prove proper playback on Windows and Linux'
status: in-progress
priority: high
labels:
  - M2
  - milestone-exit
  - cross-platform
  - audio
workstream: W6
workstreamId: W6-4
dependsOn:
  - 01KYQANT57FSNXJ6BN8WNF5NV8
  - 01KYQAQKV9YX20XQF9NE4WSKJK
effort: high
order: 6
created: '2026-07-29T16:19:08.103Z'
updated: '2026-07-29T19:30:00.000Z'
---
Turn M2's exit criteria into one repeatable, cross-platform gate. The result is evidence attached to this card, not a listening-session recollection.

## Scope

- Add an `npm`-driven M2 exit probe that runs the same experiment on Windows and Linux, following the platform-neutral approach of the M1 gate.
- Generate or check in deterministic audio fixtures as appropriate:
  - one continuous PCM signal split into two tracks for the sample-accurate gapless assertion;
  - a pair suitable for measuring the equal-power crossfade envelope;
  - tagged and untagged ReplayGain fixtures with reference results;
  - a twenty-minute track that the configured R1 policy sends to streaming.
- Record the AudioContext rate and R1 admission reason. Measure renderer memory using a cross-platform source such as Electron process metrics, not platform-specific `/proc` logic.
- Prove that the long track becomes audible through streaming without a whole-buffer decode and that peak/resident memory stays inside the configured budget.
- Exercise decoded current+next prefetch, natural transition, skip during prefetch, gapless zero duration, at least two crossfade durations, and a boundary involving streaming fallback.
- Verify ReplayGain tag application and one compute-when-missing flow including progress, cancel and resume.
- Capture warnings/errors and fail the gate on unexpected console output, unhandled rejection or leaked worker/child process.
- Run the ordinary repository gate (`lint`, `format:check`, `typecheck`, tests and build) on both platforms at the same commit.

## Exit criteria

- The split-signal test proves a sample-accurate decoded boundary and is known to fail at ±1 sample.
- The twenty-minute fallback case remains inside the memory budget and does not wait for a full decode before audio.
- Equal-power crossfade timing and envelope checks pass for the configured durations.
- Tagged ReplayGain is applied; missing ReplayGain is computed, persisted and applied after resume.
- Windows and Linux reports are attached to this card from the same script and commit.
- Any defect found becomes its own triage card. Do not fold fixes into the gate run or weaken the assertion to make the report green.

## Handoff

Once both columns pass, update the project status from M2 to M3 in the planning/readme pointers as a separate documentation commit. That status change is the declaration that M2 exited, not a substitute for the evidence above.

## Gate runbook

Run `npm run probe:m2-exit` from a clean commit on Windows and Linux. The command runs the ordinary
repository checks, builds deterministic lossless fixtures, launches the built app against an
isolated temporary database, and writes `m2-exit-<platform>.md` to the OS temporary directory.
Attach both reports here only when their commit hashes match.

The probe's `--skip-repo-gate --allow-dirty` flags are for development only. A report that records
either a skipped repository gate or a dirty tree is not exit evidence.
