---
taskId: 01M7EDA0FAJPP87783KZJXZ6VA
title: >-
  Start the measurement: Measure control, summary IPC, post-scan nudge, palette
  command
status: in-review
priority: high
labels: []
workstream: W25
workstreamId: W25-1
order: 0
created: '2026-11-15T01:31:49.608Z'
updated: '2026-11-16T20:02:40.123Z'
---
**Phase 1 — start the measurement.** RG-1 of the `oscine-replaygain` card map. Ships on its own: it fixes in-app loudness for untagged tracks without touching any file. The analyzer and `library.startReplayGain` already exist end-to-end (IPC → preload → `src/renderer/ipc.ts`); the only caller today is `scripts/m2-exit-probe.mjs`. This card gives the operator the button.

**Scope (D37 Decision A — the start is explicit; no auto-run after scan):**
- **Settings → Audio, "Measure ReplayGain" block**, under the existing ReplayGain settings: counts (tagged / measured / missing), **Start**, a progress bar with the current track, **Cancel**, and **Resume** for a cancelled or interrupted job. Disabled with the reason shown when `audio.replayGainComputeWhenMissing` is off. Fix that setting's help text, which refers to "the button" that does not exist yet — name this control.
- **Post-scan nudge:** a non-modal toast with a **Measure** action when a scan leaves `rg_source IS NULL` tracks (e.g. "1,204 tracks have no ReplayGain — Measure"). Suppressed while a job is running.
- **Command palette:** "Measure missing ReplayGain".
- **New IPC** in `src/shared/ipc.ts`: `library.getReplayGainSummary` → `{ tagged, computed, missing, failed }`.

**Progress throttling (load-bearing).** The progress event already exists (`onReplayGainProgress`). Confirm it is throttled **main-side** before any UI subscribes — an unthrottled progress stream is exactly what froze the Cancel button before (see the `abortsignal-any-electron` lesson). If it is not throttled, throttle it here.

**Tests:** renderer summary + progress model, no `@renderer` imports and no DOM.

**Open questions to resolve in this card:** OQ3 — are podcast episodes in `tracks`, and does `createJob` queue them? `fermata-design` says podcasts do not inherit album ReplayGain; they must be excluded from album finalisation and from the summary's counts.
