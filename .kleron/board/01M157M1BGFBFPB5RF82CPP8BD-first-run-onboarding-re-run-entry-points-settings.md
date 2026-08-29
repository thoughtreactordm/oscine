---
taskId: 01M157M1BGFBFPB5RF82CPP8BD
title: First-run onboarding — re-run entry points (settings button + palette)
status: in-review
priority: low
labels: []
workstream: W8
workstreamId: W8-19
dependsOn:
  - 01M157KBPZV4TXQBHYPC2J8Q4X
order: 1
created: '2026-08-28T22:25:05.903Z'
updated: '2026-08-29T00:11:45.973Z'
---
Part of **W8-14** (umbrella). Spec: wiki `oscine-onboarding` → D-ONB-6, "The flow".

Make the wizard re-runnable after first launch, from two places.

## Scope

- **Settings button** in the Library category (or a dedicated "Setup" affordance) that calls
  `useOnboardingStore().openWizard()`.
- **Command Palette action** `onboarding.rerun` — label "Run first-run setup again" — via a
  `buildOnboardingCommands` builder wired into `CommandPalette.vue`, also calling `openWizard()`.
- Re-running resets `step` to 1 but does **not** clear the done-key (re-running is not
  un-onboarding). Root step shows any existing root; no duplicate roots.

## Done when

- Both the Settings button and the palette action open the wizard at step 1.
- Re-running and finishing again does not duplicate roots and does not flip the done-key back to
  false.
