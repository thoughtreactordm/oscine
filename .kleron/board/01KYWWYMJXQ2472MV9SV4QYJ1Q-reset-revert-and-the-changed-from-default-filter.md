---
taskId: 01KYWWYMJXQ2472MV9SV4QYJ1Q
title: 'Reset, revert, and the changed-from-default filter'
status: in-review
priority: medium
labels: []
workstream: W8
workstreamId: W8-7
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 34
created: '2026-07-31T20:13:19.835Z'
updated: '2026-07-31T20:13:19.835Z'
---
The pair that makes a large settings surface diagnosable, and the reason "apply immediately with no Cancel" is safe.

Cheap to build, because the registry already knows every default and the store already knows every stored value. Expensive to omit, because without it an operator who has broken their playback has no way to find which of two hundred knobs did it — and neither does a bug report.

## Revert

- **Per setting** — a control appears on any row whose value differs from its default. Reverting deletes the stored row rather than writing the default, so the setting resumes tracking the default if that default later changes.
- **Per section** — reverts every key in a category.
- **All** — behind a confirmation, since it is the one destructive action in the settings surface.

Reverting a cascading key at an entity level restores inheritance rather than the global default; reverting at global level restores the descriptor default. W8-5's provenance is what distinguishes these, and the distinction must be visible in the button's label.

## Changed-from-default

A filter toggle in the settings view showing only keys whose resolved value differs from their descriptor default, across every category at once — the operator's whole delta on one screen. Pairs with W8-13: this is what an exported profile should look like before it is exported.

An `advanced` key that has been changed shows in this filter even when advanced disclosure is collapsed. Hiding a knob the operator has actually turned is exactly the failure mode this filter exists to prevent.

## Done when

- Revert at each of the three granularities is tested, including the delete-row-not-write-default behaviour and the cascade case.
- The filter is tested against a store containing changed, unchanged, unknown-key and advanced-and-changed values.
- Reset-all is confirmed before it fires and is a single undo-less action — say so plainly in the dialog.

---

## What landed

`src/shared/settings/kernel.ts` — `sameSettingValue` (was three private copies) and
`changedFromDefault`, so the filter cannot answer "has this moved" differently from the store it
reads.

`src/renderer/settings/settingsStore.ts` — `changedKeys`, `isStored`, `resetCategory`, `resetAll`.
`clear` was generalised from one key to a list, because main takes a category as one request and the
surface has no such shorthand: every key in it still has to be dropped, settled and re-resolved
individually whichever way the ask arrived.

`src/renderer/settings/viewStore.ts` — a reactive `storedKeys`, and `stored(key)`. The view half had
no equivalent of main's `storedKeys`, and without one an entry holding the default was invisible.

`src/renderer/panels/settings/catalog.ts` — `changed` (a set) and `changedOnly` (a flag) in,
`changedOnly` / `spanning` / `changedTotal` and a per-section `changed` count out.

`SettingRevertButton.vue`, `ResetAllDialog.vue`, and the three components that use them.

`src/renderer/stores/settingsNav.ts` — `changedOnly` and `toggleChangedOnly`. Still holds only where
you are looking: which keys are changed is a question about values, so the flag and the set reach
`buildSettingsCatalog` separately.

### Decisions worth knowing

- **Two predicates, not one.** `changedKeys` is "the value has moved off its default" and drives the
  filter. `isStored` is "there is a row here" and drives the per-row revert. They coincide except for
  a row holding exactly the default — which has changed nothing on screen, so it stays out of the
  delta, but *is* the row that stops the key tracking a default a later build moves. Offering to
  delete it is the only way to say so.
- **The set is a parameter, not a read.** `buildSettingsCatalog` stays pure and stays testable
  without a store: "changed", "unchanged", "a key nobody has a descriptor for" and "advanced and
  changed" are four cases that are trivial to state as a set and awkward to arrange through a store.
- **`spanning`, not `filtered`.** A query and the changed filter both mean "rows come from every
  category", and every component that had been asking `filtered` really wanted that. Spelling out
  which of the two is on at each call site would have been wrong the first time a third landed.
- **A sweep is one request.** `resetCategory` sends `{ category }` and `resetAll` sends `{}`; main
  already resolves both. A loop would be N round trips and N broadcasts for one operator action.
- **The section revert is not behind a confirmation, and reset-all is.** The card's split, and it
  holds up: a section is a scope you can see the whole of, every row in it carries its own revert,
  and the delta count above says exactly what is about to go.

### Done when — evidence

- **Revert at each of the three granularities, including delete-row-not-write-default and the
  cascade case** — `tests/renderer/settings/revert.test.ts` (14 tests). The delete case is asserted
  in both halves: a view entry is gone from storage rather than rewritten, and a durable row that
  held *exactly the default* is still deleted. The cascade case is `cascade.test.ts`'s two existing
  tests plus a new one here pinning the label distinction — `the global setting` at an entity,
  `the built-in default` at the global.
- **The filter against changed, unchanged, unknown-key and advanced-and-changed** —
  `tests/renderer/panels/settingsCatalog.test.ts`, six new tests, plus the unknown-key and
  stored-at-default cases in `revert.test.ts` against the real store.
- **Reset-all is confirmed before it fires and says so plainly** — `ResetAllDialog.vue`. Confirmed in
  the live run: Cancel left the delta intact, and the body reads "It happens immediately and
  **cannot be undone**: nothing keeps a copy of what the values were."
- `lint`, `format:check`, `typecheck` and `test` (80 files, 1229 tests) clean.

### The live run

Second instance against a throwaway user-data directory, driven over CDP.

- Fresh profile reads `Changed from default (0)`. Moving one durable and one view key takes it to
  `(2)`, and the rail's per-section counts to `Audio 1 / Interface 1`.
- The filter spans categories: both rows draw with their `Audio ▸` / `Interface ▸` prefix, and each
  carries `Revert to the built-in default` as its accessible name.
- Pressing a row's revert inside the filtered list dropped `audio.crossfadeMs` back to `0`, took
  `isStored` to false and the row out of the list in the same frame.
- **Advanced and changed**: with Audio's disclosure explicitly shut, `audio.replayGainPreampDb`
  appears in the filter and is correctly still absent from the ordinary Audio section.
- `Revert section (1)` — titled `Revert every Audio setting to the built-in default` — cleared that
  advanced key despite the shut disclosure and left the Interface view key alone. The button then
  disappeared, because nothing in the section had changed.
- Reset-all: Cancel gated it, confirm emptied both halves — `localStorage` held no `fermata.view.*`
  entries afterwards and the delta was `[]`.
- **The pinned-at-default case, end to end**: writing `audio.crossfadeMs = 0` left
  `Changed from default (0)` and `isStored` true, and the row still drew its revert button.

### Left for the cards that own them

- **Export** — W8-13. `changedKeys` is the shape an exported profile should be built from, and it is
  reactive and public for that reason.
- **An entity-scope revert has no on-screen consumer yet.** `SettingRevertButton` takes the
  destination phrase so the first per-playlist control gets it for free; until one exists, the
  distinction is proved at the `provenanceLabel` level rather than in a template.
