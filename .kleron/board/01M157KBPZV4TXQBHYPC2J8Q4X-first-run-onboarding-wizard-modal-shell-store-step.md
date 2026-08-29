---
taskId: 01M157KBPZV4TXQBHYPC2J8Q4X
title: 'First-run onboarding — wizard modal shell, store & step framework'
status: in-review
priority: low
labels: []
workstream: W8
workstreamId: W8-16
order: 2
created: '2026-08-28T22:24:43.743Z'
updated: '2026-08-28T23:54:07.552Z'
---
Part of **W8-14** (umbrella). Spec: wiki `oscine-onboarding` → D-ONB-1, D-ONB-4, "The flow".
**Keystone** — the step cards (14c/14d/14e) and re-run (14f) build on this.

The dismissible modal frame plus the descriptor-projection plumbing, with no step content yet.

## Scope

- **`useOnboardingStore`** (Pinia): `open`, `step`, `openWizard()` (resets `step` to 1, sets
  `open=true`; does **not** clear the done-key), `close()`.
- **`<UModal>` mounted once in `AppShell.vue`** beside `NewPlaylistModal` / `CommandPalette`, over
  the dimmed shell. Bound to the store `open` flag — same idiom as the other frame modals.
- **Linear next/back** with a step indicator; skippable steps say so ("Skip — you can change this
  later"). Root step (14c) gates Next.
- **Cancel / X / Esc are identical:** close the modal, keep all applied work, set
  `interface.onboardingCompleted = true` (14a's key). No rollback, no end-of-wizard flush — each step
  commits as chosen.
- **Surface renderer.** A step declared as `{ title, blurb, keys: string[] }` (same shape as W8-8's
  `PanelSettingsSurface`) renders through the existing `SettingField.vue` / `SettingControl.vue`
  stack, two-way bound to `settings.set`. **No hand-written controls; do not pre-write defaults on
  mount.** Steps get their content in 14c–14e.

## Done when

- `openWizard()` shows the modal over a dimmed shell; back/next move between placeholder steps.
- Closing by any means keeps applied work and sets the done-key so it will not reappear.
- A surface of `{ keys: [...] }` renders live `SettingField` rows with zero hand-written markup.
