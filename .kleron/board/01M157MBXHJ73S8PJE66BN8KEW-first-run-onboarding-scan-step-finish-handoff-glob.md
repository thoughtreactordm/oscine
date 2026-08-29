---
taskId: 01M157MBXHJ73S8PJE66BN8KEW
title: 'First-run onboarding — scan step, Finish handoff & global indexing indicator'
status: done
priority: low
labels: []
workstream: W8
workstreamId: W8-20
dependsOn:
  - 01M157KBPZV4TXQBHYPC2J8Q4X
  - 01M157KNGJHKK2E76JWCREYGM0
order: 4
created: '2026-08-28T22:25:16.720Z'
updated: '2026-08-29T02:55:08.017Z'
---
Part of **W8-14** (umbrella). Spec: wiki `oscine-onboarding` → "The flow" step 5, "Discovered gap".

The final step and the handoff into the running app — plus the small persistent indicator that keeps
the "don't dump into an empty-looking app" intent alive after the modal closes.

## Scope

- **Scan step** — visualize `roots.scan` from `useLibraryRootsStore` (`tracksIndexed`, `filesSeen`,
  current file basename). It only reads progress already underway (kicked off in 14c); it does not
  start a scan.
- **Non-blocking Finish** — available immediately; dismisses the modal into the app while indexing
  continues in the background.
- **Global indexing indicator** *(folded in from the discovered gap)* — a minimal always-on element
  (title bar / status region) that renders `roots.scan` whenever a scan is in flight, so a mid-scan
  dismissal still shows an "indexing…" cue. Today `roots.scan` is consumed only to disable buttons;
  nothing renders it. Keep it small and reuse the store — do not add a second scan-state source.

## Done when

- The Scan step reflects live progress from the same store the background scan feeds.
- Finish is clickable before the scan completes and returns the operator to the app.
- After dismissal mid-scan, the global indicator shows progress and clears when `roots.scan` goes
  null (done).
