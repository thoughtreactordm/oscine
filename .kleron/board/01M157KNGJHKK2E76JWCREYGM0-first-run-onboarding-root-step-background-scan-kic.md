---
taskId: 01M157KNGJHKK2E76JWCREYGM0
title: First-run onboarding — root step & background scan kickoff
status: done
priority: low
labels: []
workstream: W8
workstreamId: W8-17
dependsOn:
  - 01M157KBPZV4TXQBHYPC2J8Q4X
order: 6
created: '2026-08-28T22:24:53.778Z'
updated: '2026-08-29T02:55:08.043Z'
---
Part of **W8-14** (umbrella). Spec: wiki `oscine-onboarding` → D-ONB-2, D-ONB-3, "The flow" step 1.

The one mandatory step, and the point where indexing begins.

## Scope

- Folder picker via existing `library.addRoot` (main-side dialog, returns `LibraryRoot | null`,
  de-dup guarded). **Exactly one root** during first-run.
- On a successful add, **immediately** `library.scanRoot({ rootId })` so indexing runs in the
  background while the operator continues through theme / audio / network (D-ONB-2). The Scan step
  (14e) only visualizes this; it does not start it.
- **Next is enabled only once a root exists.**
- Re-run safety: if a root already exists (re-running from Settings), show it; adding is idempotent —
  never duplicate a root.

## Done when

- Picking a folder adds one root and kicks off a background scan without blocking navigation.
- Next is disabled until a root is present.
- Re-running with an existing root does not create a duplicate.
