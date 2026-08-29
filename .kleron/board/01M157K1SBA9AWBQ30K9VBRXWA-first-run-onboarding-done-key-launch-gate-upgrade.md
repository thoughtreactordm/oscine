---
taskId: 01M157K1SBA9AWBQ30K9VBRXWA
title: 'First-run onboarding — done-key, launch gate & upgrade backfill'
status: done
priority: low
labels: []
workstream: W8
workstreamId: W8-15
order: 2
created: '2026-08-28T22:24:33.578Z'
updated: '2026-08-29T02:55:07.991Z'
---
Part of **W8-14** (umbrella). Spec: wiki `oscine-onboarding` → D-ONB-7, "The done-key and launch gate".

Add the durable key that decides whether the wizard runs, and the launch gate that opens it — without
ever re-onboarding an existing install.

## Scope

- New setting **`interface.onboardingCompleted`**: `scope: 'durable'`, `internal: true`,
  `portable: false`, `default: false`. `internal` keeps it out of the changed-from-default filter
  (W8-7) and the palette's generated settings commands; `portable: false` so an imported profile
  (W8-13) can't suppress the wizard on a fresh machine.
- **Main-process fresh detection.** On startup, when the key is unset, main sets it `true` for a
  **non-fresh** profile — existing library DB with rows/roots, *or* any durable setting already
  written — and leaves it `false` only for a truly fresh user-data dir. Do **not** gate on
  "is the library empty": an operator who removed every root stays onboarded.
- **Renderer launch gate.** In `AppShell.vue` mount, read
  `settings.get('durable', 'interface.onboardingCompleted')` after hydration; `false` →
  `useOnboardingStore().openWizard()` (store lands in W8-14b — until then, stub the call site).

## Done when

- A fresh user-data directory reports the key `false`; a profile with an existing DB or any written
  durable setting reports `true`.
- A second launch after completion does not re-open the wizard.
- The key does not appear in the changed-from-default filter or the command palette.

## Tests

- `tests/main/`: fresh dir → `false`; seeded root → `true`; seeded durable setting only → `true`.
- Idempotent: running the gate twice does not flip an operator-set value.
