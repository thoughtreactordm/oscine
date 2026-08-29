---
title: Oscine — First-run onboarding
created: '2026-08-28T22:24:14.675Z'
updated: '2026-08-28T22:24:14.675Z'
---
The implementation record for **W8-14 — First-run setup and onboarding**. The onboarding wizard
is the settings registry rendered as a modal: a first launch on a fresh user-data directory drops
the operator into a can't-miss dialog whose only mandatory step is adding a library root, and whose
every other step is a projection of the same registry descriptors the settings panel and W8-8's
popovers already render. Read the parent card and `fermata-quick-access` (command palette, settings
registry) before touching this.

This page records the decisions settled 2026-08-28 so the sub-cards (W8-14a…f) can be cut and worked
independently. It is the design authority for onboarding; the parent card is the umbrella.

## Settled decisions

- **D-ONB-1 — Modal over the dimmed shell, not a full-window route.** The wizard is a Nuxt UI
  `<UModal>` mounted once in `AppShell.vue` alongside `NewPlaylistModal` / `CommandPalette`, driven
  by a Pinia `useOnboardingStore` (`open`, `step`, `openWizard()`, `close()`). This reuses the
  established "store flag flips a modal mounted in the frame" idiom (`AddToPlaylistStore` →
  `NewPlaylistModal`) rather than inventing a routed takeover. *Revisit when* onboarding grows past
  what a modal can hold (it should not — five steps).

- **D-ONB-2 — Indexing starts the instant the root is added, in the background.** The root step
  calls `library.addRoot` then immediately `library.scanRoot({ rootId })`, so the scan overlaps the
  theme / audio / network steps and the library is largely ready by Finish. The final Scan step
  *visualizes progress already underway*; it does not start it. *Revisit when* scan cost on a cold
  cache makes early kickoff feel like a stall rather than a head start.

- **D-ONB-3 — Single root during first-run.** Exactly one folder; additional roots are added later
  from Library settings. Keeps the mandatory step to one decision.

- **D-ONB-4 — Cancel keeps applied work and marks onboarding done.** Cancel / X / Esc are all the
  same: they close the modal, keep every choice already applied (root, scanned data, any changed
  setting), and set the done-key so the wizard does not reappear. There is no rollback and no
  half-applied batch, because **each choice commits as it is made** — the wizard never gathers a
  pending batch to flush at the end. Re-run from Settings covers "I closed it by accident."

- **D-ONB-5 — ReplayGain is one toggle bound to `audio.replayGainMode` (off ↔ `track`).** Preamp,
  fallback and `replayGainComputeWhenMissing` stay at their defaults and are not surfaced in the
  wizard. The one-sentence explanation the card asks for is the field's help text.

- **D-ONB-6 — Re-runnable from a Settings button *and* a Command Palette action.** Both call
  `openWizard()`; re-running resets `step` to 1 but does **not** clear the done-key (re-running is
  not un-onboarding).

- **D-ONB-7 — Upgraders are never re-onboarded; detection lives in main.** See "The done-key".

## The done-key and launch gate

A new durable setting **`interface.onboardingCompleted`**: `scope: 'durable'`, `internal: true`,
`portable: false`, `default: false`.

- `internal: true` keeps it out of the changed-from-default filter (W8-7 stays honest) and out of
  the palette's generated settings commands.
- `portable: false` so a profile imported from another machine (W8-13) cannot suppress the wizard on
  a genuinely fresh install, and completing onboarding here cannot un-onboard a machine you export to.

**Fresh-vs-non-fresh detection lives in the main process**, where the SQLite DB and settings store
are. On startup, when the key is unset, main sets it `true` for a **non-fresh** profile — an existing
library DB with rows or roots, *or* any durable setting already written — and leaves it `false` only
for a truly fresh user-data directory. This is what satisfies both card rules at once: it does **not**
gate on "is the library empty" (an operator who deliberately removed every root keeps
`onboardingCompleted = true` and is left alone), yet upgraders with an existing library are never
dropped back into the wizard.

The renderer reads the resolved value synchronously after hydration in `AppShell.vue`'s mount
(`settings.get('durable', 'interface.onboardingCompleted')`); `false` → `openWizard()`.

## The flow

Steps 2–4 are declared as surfaces — `{ title, blurb, keys: string[] }`, the same shape as W8-8's
`PanelSettingsSurface` — and rendered through the existing `SettingField.vue` / `SettingControl.vue`
stack. **No hand-written controls.** A changed default or label in the registry propagates here for
free. Steps 1 and 5 are the two non-setting specials.

1. **Root** *(mandatory)* — folder picker via `library.addRoot` (main-side dialog, returns
   `LibraryRoot | null`, de-dup guarded). On success, immediately `library.scanRoot({ rootId })` to
   begin background indexing (D-ONB-2). **Next** is enabled only once a root exists.
2. **Theme** *(skippable)* — keys `theme.mode` (system / light / dark) and `theme.name` (built-ins).
   Live preview is the ordinary `settings.set`-on-change the real settings panel already uses.
3. **Audio** *(skippable)* — `audio.outputDevice` (custom `OutputDeviceControl`) and the ReplayGain
   on/off toggle bound to `audio.replayGainMode` (D-ONB-5).
4. **Network** *(skippable, conditional)* — the key is **W7's** D14 consent key; W8 does not own it.
   Presence is detected via a `SETTINGS_REGISTRY` lookup: **if the key is not registered, the whole
   step is dropped** (omitted, never stubbed). Default declined; declining is as prominent as
   accepting.
5. **Scan** *(final)* — visualizes `roots.scan` from `useLibraryRootsStore` (`tracksIndexed`,
   `filesSeen`). **Finish is available immediately** (non-blocking) and dismisses into the app.

**Write discipline.** Controls are two-way bound straight to `settings.set`, so navigating past an
untouched step writes nothing and skipping every optional step leaves the changed-from-default filter
empty. **Do not pre-write defaults on mount.** The wizard never writes a value the operator did not
choose.

## Discovered gap — global scan indicator

There is no persistent scan-progress UI today: `roots.scan` in `useLibraryRootsStore` is consumed
only to disable buttons (`AppTitleBar.vue`, `Sources.vue`), nothing renders it. Because indexing now
starts in the background (D-ONB-2) and the modal is dismissible, closing mid-scan would drop the
operator into an app with no "indexing…" cue — exactly what the Scan step argues against. A **minimal
always-on indicator** (title bar / status region reading `roots.scan`) is therefore **in scope for
W8-14e** so the intent survives the modal closing.

## Sub-cards

- **W8-14a** — done-key `interface.onboardingCompleted` + main-side fresh detection + `AppShell`
  open-on-launch. *Done: fresh dir → wizard; non-fresh profile and every second launch → suppressed.*
- **W8-14b** — `useOnboardingStore` + `UModal` shell mounted in `AppShell` + linear next/back with
  skip copy + cancel/close/Esc = keep-and-mark-done + surface→`SettingField` rendering. Keystone the
  step cards build on.
- **W8-14c** — Root step: single-folder `addRoot`, immediate background `scanRoot`, Next gating.
- **W8-14d** — Theme / Audio / Network steps as descriptor surfaces; Network conditional on W7's key.
- **W8-14e** — Scan step + non-blocking Finish handoff + the minimal global indexing indicator.
- **W8-14f** — Re-run entry points: Settings button + `onboarding.rerun` palette command, both
  calling `openWizard()`.

## Done when (parent card)

- A fresh user-data directory produces the wizard; a second launch does not.
- Re-running from settings works and does not duplicate roots.
- Skipping every optional step leaves an empty changed-from-default filter.
- The network step reads W7's key, or is absent.
