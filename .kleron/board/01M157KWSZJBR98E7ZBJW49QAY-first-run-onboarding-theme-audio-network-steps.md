---
taskId: 01M157KWSZJBR98E7ZBJW49QAY
title: 'First-run onboarding — theme, audio & network steps'
status: done
priority: low
labels: []
workstream: W8
workstreamId: W8-18
dependsOn:
  - 01M157KBPZV4TXQBHYPC2J8Q4X
order: 7
created: '2026-08-28T22:25:01.247Z'
updated: '2026-08-29T02:55:08.053Z'
---
Part of **W8-14** (umbrella). Spec: wiki `oscine-onboarding` → D-ONB-5, "The flow" steps 2–4.

The three skippable descriptor-projection steps. Each is a surface (`{ title, blurb, keys }`) rendered
through the 14b framework — **no hand-written controls, no pre-writing defaults**.

## Scope

- **Theme** — keys `theme.mode` (system/light/dark) and `theme.name` (built-ins). Live preview is the
  ordinary `settings.set`-on-change the settings panel already uses.
- **Audio** — `audio.outputDevice` (custom `OutputDeviceControl`) and a single ReplayGain on/off
  toggle bound to `audio.replayGainMode` (off ↔ `track`); preamp / fallback / compute stay at
  defaults. The explanatory sentence is the field's help text.
- **Network** *(conditional)* — the D14 consent key **owned by W7**. Detect via `SETTINGS_REGISTRY`
  lookup: if the key is not registered, **drop the whole step** (omit, never stub). Default declined;
  declining as prominent as accepting. Read/write only W7's key — invent none.

## Done when

- Each step renders its keys as live `SettingField` rows; skipping writes nothing.
- The ReplayGain toggle flips only `audio.replayGainMode`.
- With W7's key absent from the registry, the network step does not appear; with it present, the step
  reads and writes exactly that key.
