---
taskId: 01KYWX0K27SPJEB14SPR5TPN5J
title: Theme selection and operator-authored token overrides
status: done
priority: medium
labels: []
workstream: W8
workstreamId: W8-12
workstreamDependsOn:
  - W4
dependsOn:
  - 01KYWWY6TM6XQA3NB7YHQWZZG4
order: 9
created: '2026-07-31T20:14:23.814Z'
updated: '2026-08-02T13:14:31.171Z'
---
W4 owns the token layer. W8 owns choosing a theme and authoring one.

> **The block did not hold, and the card grew.** `src/renderer/theme/` was a
> single `main.css` and no card for the token layer existed anywhere on the
> board — W8-12 was not waiting on a workstream, it was waiting on somebody
> deciding to write it. Per **T8** this card absorbed it. The full decision log
> is the wiki page `fermata-theme-token-layer` (T1–T16, and the D9 amendment
> that lets the editor ship over a curated public token subset).
>
> Accepted cost of T8: this card now tests something it authored, so "zero
> component changes" is checked three ways rather than asserted once.

## Keys

- `theme.mode` — light, dark, or follow-system. Following the system means reacting to the OS change live, on both platforms.
- `theme.name` — the selected built-in theme.
- `theme.overrides` — a map of token name to value, authored by the operator, layered over the selected theme. Durable and exportable.

**T9 renamed `interface.theme` to `theme.mode`** and gave theming its own
settings category — a ~40-token surface buried in Interface is unfindable.
Migration `008-theme-keys` carries the stored row across, and
`legacyViewKeys.ts`'s absorb pattern handles the store-level rename.

## Authoring

A token editor listing every token the theme layer defines, with its current value, its source (theme or override), and a revert — the same provenance idea as W8-5, applied to CSS custom properties. Grouped by token category so it is navigable, and searchable, because there will be a lot of them.

Live preview is the default and costs nothing given W8-4: writing an override sets the custom property and the app repaints. No apply button, no preview mode.

An override naming a token the current theme does not define is kept, not dropped — the unknown-key rule again, and it matters here because themes will gain and lose tokens.

## What landed

| # | What | Commit |
|---|---|---|
| 1 | `src/shared/theme/` — catalog, three built-ins, OKLCH ramps, contrast, overrides. Pure, `@shared`-only | `9beff38` |
| 2 | The bridge and application; light/dark stops being dead code | `0cdec21` |
| 2a | Mode toggle wiring, and the contrast revert (T14) | `fe0bf0c` |
| 2b | Coexistence with `UColorModeSwitch` (T13) | `ea71c5e` |
| 2c | The High Contrast theme (T14a) | `aa6a16a` |
| 3 | Window background read from the resolved token | `ecaff26` |
| 4 | The `theme` category and the `interface.theme` migration (T9) | `85125bd` |
| 6 | `fermata/no-raw-colours`, wired into the flat config | `8ee5666` |
| 5 | The token editor | `a29af3f` |

Gate green at `a29af3f`: lint, format, typecheck, 96 files / 1507 tests, build.

**The editor is seven files under `src/renderer/panels/settings/theme/` plus one
line in `customControls.ts`.** Nothing else on the settings surface changed,
which independently proves W8-6's claim that adding a setting requires zero edits
to that view. It is also the first entry in the escape hatch W8-6 built and
deliberately left empty for a key with no generic control — `theme.overrides`
holds a map (T6), and a map is exactly that.

## Done when

- ✅ **Theme swap and override authoring both work with zero component changes,
  and that claim is checked rather than asserted.** Checked three ways: the
  `fermata/no-raw-colours` ESLint rule as a standing guard, with
  `tests/tooling/` linting fixtures through the real config so it cannot quietly
  stop being wired up; Nocturne shipped off-palette (hue 197) so the swap
  exercises a hue the generated Tailwind ramps cannot produce; and the live run
  below, where a `surface.base` override repainted `--ui-bg` and a seeded
  `color.primary` drove `--ui-primary` with no component touched.
- ⬜ **Follow-system reacts to a live OS theme change on Windows and Linux.**
  Linux verified. **Windows is not, and needs a real run** — `nativeTheme` drives
  the window background and VueUse drives the class, so both paths need checking
  there. This is the one outstanding item on this card.
- ✅ **Overrides survive a theme switch**; the export half is W8-13's, and the
  editor can now author a non-trivial blob to round-trip.
- ✅ **Contrast is not silently destroyable.** T7: WCAG 2.1 AA, warn-only —
  4.5:1 body and 3:1 large, inline on the offending row and summarised in the
  footer in words ("secondary text — artist, album, duration"), never blocking
  the write. Refusing it would make a deliberately low-contrast theme
  unauthorable.

## Live-run evidence

Second dev instance, throwaway user-data directory, driven over CDP.

- The stated gap is gone; the `theme.overrides` row draws its control.
- A colour override repainted `--ui-bg` and the body background on the next tick,
  with no apply button pressed.
- A seed of `oklch(62% 0.21 265)` derived all eleven steps at hue 264.85 and drove
  `--ui-primary`; stored normalised as `oklch(61.73% 0.2059 264.85)`.
- The ramp editor opened on **Tailwind amber** — `describeRamp` reading the mode
  back out of the resolved ramp (T5a), not a stored flag.
- Four overrides survived all three theme swaps and a full reload from SQLite.
- `legacy.sidebar.tint` rendered as an orphan with its value visible and a revert,
  and stayed visible under the changed filter. The unknown-key rule, on screen.
- A 30% body text wrote and repainted, producing two footer warnings naming the
  pairings; nothing was blocked.
- Per-row revert cleared the key, the value and the warning; Revert all emptied
  the map and restored the theme.
- Switching mode moved the editor's effective values, swatches, header and the
  `.dark` class together.

Not verified: the reduced-motion banner — there was no way to assert the OS
preference from the probe.

## Debts this leaves

- **W8-6's recorded live-run evidence cites `interface.theme`**, which T9
  renames. That evidence is stale; the mechanism it proved is not.
- **T6 puts per-token revert and provenance in the editor** rather than in the
  W8-5/W8-7 machinery. If a second map-valued setting ever appears, that is the
  moment to reconsider dynamic keys in a registry built on static descriptors.
- **Sharable theme files stay unbuilt.** The public/private token split (T1) is
  what would make them cheap later, so it is the enabling half of a decision D9
  has not yet been asked to take.
- **No border-width token** (T15). Tailwind compiles `.border` to a literal
  `1px` with no variable behind it, so the token would appear in the editor,
  accept a value and change nothing.
