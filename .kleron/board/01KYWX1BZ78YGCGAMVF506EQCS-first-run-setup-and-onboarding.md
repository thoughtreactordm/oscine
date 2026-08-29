---
taskId: 01KYWX1BZ78YGCGAMVF506EQCS
title: First-run setup and onboarding
status: in-review
priority: low
labels: []
workstream: W8
workstreamId: W8-14
dependsOn:
  - 01M157K1SBA9AWBQ30K9VBRXWA
  - 01M157KBPZV4TXQBHYPC2J8Q4X
  - 01M157KNGJHKK2E76JWCREYGM0
  - 01M157KWSZJBR98E7ZBJW49QAY
  - 01M157M1BGFBFPB5RF82CPP8BD
  - 01M157MBXHJ73S8PJE66BN8KEW
order: 0
created: '2026-07-31T20:14:49.317Z'
updated: '2026-08-28T23:54:07.525Z'
---
**Umbrella.** The design is settled and cut into sub-cards — see wiki **`oscine-onboarding`** for the
full spec (decisions D-ONB-1…7, the done-key/launch gate, the flow, and the discovered global-scan-
indicator gap). This card tracks the whole; work the children.

## Breakdown

- **14a** — done-key `interface.onboardingCompleted` + main-side fresh detection + `AppShell`
  open-on-launch.
- **14b** *(keystone)* — `useOnboardingStore` + `<UModal>` shell in `AppShell` + linear next/back +
  cancel=keep-and-mark-done + surface→`SettingField` rendering.
- **14c** — root step (single folder) + immediate background `scanRoot`.
- **14d** — theme / audio / network steps as descriptor surfaces (network conditional on W7's key).
- **14e** — scan step + non-blocking Finish + minimal global indexing indicator.
- **14f** — re-run entry points (Settings button + `onboarding.rerun` palette command).

---

The registry rendered as a wizard. Cheap once everything above exists, and currently owned by nobody — a first launch today drops the operator into an empty shell with no root and no indication that adding one is the next move.

## The flow

1. **Add a root.** The only mandatory step. Everything else is skippable, and the wizard says so.
2. **Theme.** Light, dark, follow-system, and the built-in themes — whatever W8-12 has landed. Preview live.
3. **Audio.** Output device, and ReplayGain on or off with a sentence explaining what it does.
4. **Network features.** A decline-or-accept for D14's consent gate. **W8 does not own that gate** — W7 does, in its "Network consent gate and settings" card. This step reads and writes the setting W7 defines and must not invent its own; if W7 has not landed, the step is omitted rather than stubbed. Default is declined, and declining must be as easy as accepting.
5. **Scan.** Kick off the initial scan and show progress in place rather than dumping the operator into an app that appears empty while it indexes.

Every step is a projection of registry descriptors, same as W8-8's popovers — no hand-written controls, so a changed default or label propagates here for free.

## Rules

- Runs once, tracked by a durable key, and is re-runnable from settings. Do not gate it on "is the library empty" — an operator who deliberately removed every root should not be onboarded again.
- Skipping leaves defaults in place; the wizard never writes a value the operator did not choose, so the changed-from-default filter (W8-7) stays honest on a fresh profile.
- Cancellable at any point without leaving half-applied state.

## Done when

- A fresh user-data directory produces the wizard; a second launch does not.
- Re-running from settings works and does not duplicate roots.
- Skipping every optional step leaves an empty changed-from-default filter.
- The network step reads W7's key, or is absent.
