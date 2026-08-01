---
title: Fermata theme token layer
created: '2026-08-01T18:02:09.028Z'
updated: '2026-08-01T18:02:09.028Z'
---
The implementation record for **W8-12 — Theme selection and operator-authored token overrides**, which by
decision absorbs the token layer W4 was nominally to own. This document is the plan and the decision
log; the design authority remains `fermata-design`, and **D9 is amended by this work** (see below).

## Why this document exists

W8-12's card assumed the token layer existed and W8 only had to choose a theme and author one. It does
not exist. The findings below were established against the tree at `e30a3ce` before any decision was
taken, and three of the four change the shape of the card.

## What was actually there

1. **The token layer is unowned, not queued.** W4 holds exactly five cards, `W4-1`…`W4-5`, all `done`,
   and none of them is the token layer. No card for it exists anywhere on the board. W8-12 was not
   waiting on a workstream; it was waiting on someone deciding to write it.

2. **`interface.theme` is read by nobody — but light and dark do work.** The descriptor at
   `src/shared/settings/interface.ts:71` validates, writes to SQLite, and nothing consumes it.

   > **Correction.** This finding originally read "the app is permanently light" and that was wrong.
   > It is repeated in the first two commit messages. Nuxt UI's Vite plugin injects
   > `runtime/vue/plugins/color-mode`, which calls VueUse's `useDark()`; that applies `.dark`, and
   > `UColorModeSwitch` in the title bar drives it. The mechanism is injected from `node_modules` by
   > the build plugin, so grepping `src/` for `prefers-color-scheme` / `classList` and checking
   > `package.json` for `@vueuse` both came back empty. `@vueuse/core` was a transitive dependency and
   > is now a direct one. `.dark` at `src/renderer/theme/main.css:37` was never dead code.

   What is true: the durable setting and the switch were two unconnected preferences, and
   `backgroundColor: '#0a0a0a'` at `src/main/index.ts:117` — commented "matches the dark surface token
   so launch does not flash white" — named a token that did not exist.

3. **`main.css` is 85 lines and defines three real theme tokens** — `--fermata-cover-bleed`, `-blur`,
   `-drift` — plus two deliberately fixed ones (`--fermata-scrim`, `--fermata-on-scrim`, which sit over
   arbitrary cover art and so cannot be theme colours). Everything else is Nuxt UI's `--ui-*`,
   generated from `primary: amber` / `neutral: taupe` in `electron.vite.config.ts:111`.

4. **The starting position is far better than the card feared.** Across 40 `.vue` files there are
   **zero** hardcoded colour literals (hex, `rgb()`, `oklch()`, `hsl()`) and **zero** bare Tailwind
   palette utilities (`bg-amber-500` and friends). Every component already consumes Nuxt UI's semantic
   classes — `text-highlighted`, `bg-elevated`, `border-default`. M5's exit criterion is closer to
   already-true than the card assumes: this is not a 40-component sweep, it is a change to what those
   semantic classes resolve to.

## The D9 amendment

D9 as written reads:

> **D9 — Theming: token layer + curated themes.** Every component is built against CSS custom-property
> tokens over Nuxt UI, shipping several tuned themes and an accent picker. Themeable by construction,
> with no editor exposed yet — which keeps the token names private until they have settled. Sharable
> theme files would make those names a public API.

W8-12 asks for precisely the editor D9 defers, and D9 carries no "revisit when" trigger, so this was
escalated rather than decided.

**Resolution: the editor ships, over a curated public subset.** D9's stated concern is an unbounded
public API, not the editor as such. Tokens are therefore split in two — a documented, deliberately
small public set the editor exposes and whose names we commit to keeping stable, and an internal set
that stays private and uneditable. D9's "no editor exposed yet" clause is superseded; its reasoning is
honoured by the public/private split rather than by deferral.

Sharable theme files remain out of scope, so that half of D9 stands unfired.

## Decisions

| # | Decision | Rejected alternative and why |
|---|---|---|
| T1 | Editor over a curated public token subset; internal tokens stay private | Exposing every token — makes the whole surface a compatibility commitment from the first commit. Deferring the editor — leaves the bedrock feature unbuilt. |
| T2 | **Fermata semantics are the source of truth and drive Nuxt UI.** `--fermata-*` is the real layer; `--ui-*` are assigned from it | A thin alias layer over Nuxt UI limits every theme to a Tailwind palette. `main.css`'s own comment says a hand-rolled ramp earns its keep "once a shipped theme needs a hue Tailwind does not carry" — an operator-authored theme *is* that trigger firing. |
| T3 | `nativeTheme` in main is authoritative, pushed over IPC, with a pre-paint replay from `localStorage` | Renderer `matchMedia` alone leaves main unable to set a correct window `backgroundColor`, so the launch flash is unfixable. |
| T4 | Built-in themes compiled in; `theme.overrides` is the only authoring surface | On-disk theme files make token names a hard public API immediately — the exact thing D9 defers. |
| T5 | **Colour, shape, motion and type tokens** — themes are structural, not just palettes | Colour-only is the smaller naming commitment but the weaker read of the customization premise. |
| T5a | Each colour role gets an **Advanced toggle** with three authoring modes: a single seed with the ramp derived in OKLCH, a named Tailwind palette, or a hand-authored 50–950 ramp | Ramps stay invisible until asked for, so the default public API stays small while full control remains reachable. |
| T6 | `theme.overrides` is **one durable key holding a validated JSON map** | One row per overridden token would inherit W8-5/W8-7 provenance and revert for free, but needs dynamic keys in a registry built on static descriptors. Per-token revert is implemented inside the editor instead. |
| T7 | **WCAG 2.1 AA, warn only.** 4.5:1 body / 3:1 large, warned inline on the offending row, never blocking | APCA is more accurate for a dark-first player but unfamiliar. Refusing the write would make contrast an invariant at the cost of a deliberately low-contrast theme being unauthorable. |
| T8 | **One card.** W8-12 absorbs the token layer | A separate W4 card would keep W8-12 an independent proof of "zero component changes"; accepted cost is that W8-12 now tests something it authored. |
| T9 | New **`theme` settings category**; `interface.theme` migrates to `theme.mode` | A ~40-token surface buried in Interface is unfindable. Costs a store-level key rename — the kernel's `version`/`upgrade` machinery upgrades *values*, not key names — plus a legacy absorb modelled on `src/renderer/settings/legacyViewKeys.ts`. W8-6's recorded evidence citing `interface.theme` goes stale. |
| T10 | **Three built-ins**: Fermata (amber/taupe), Nocturne (off-palette, hue 197), High Contrast | Two would leave the "any hue" claim untested until someone authors a theme, which is the failure mode where the architecture quietly does not work. |
| T11 | Three **font roles** — Heading, List item, General text — each with family, weight and italic. Curated cross-platform stacks plus a free-text escape hatch | Enumerating installed system fonts is the best experience but adds a platform-specific main-process surface and stores a value that means nothing on the other machine, fighting W8-13's export. |
| T12 | **OS reduced-motion clamps duration tokens at the token layer, always** | A three-state operator setting gives more control; clamping means an accessibility preference cannot be defeated by authoring a theme. |
| T13 | **Ownership is split three ways rather than taken.** VueUse owns the `.dark` class and the system query; `interface.theme` owns persistence; the token layer owns which colours a mode resolves to. The two preference stores sync both ways, each guarded by an equality check | Taking ownership of the class broke `UColorModeSwitch`, which already worked. `useColorMode()` from `@vueuse/core` is the *same* store Nuxt UI's stub wraps — same `vueuse-color-scheme` key — so reading it is reading what the switch wrote. The pre-paint replay falls out for free: `installTheme` reads that key by name before `createApp`, because the composable needs an app context that does not exist yet. |
| T14 | **The shipped defaults keep Nuxt UI's text ladder and borders; the pushed ladder becomes the High Contrast theme** | Only `text.dimmed` (2.55:1) actually failed a threshold — `muted`, `toned` and `base` passed with room (4.95, 7.89, 10.63) and were moved solely to keep five weights distinct. That made light mode heavy for contrast nobody asked for. Widening every gap is what a high-contrast *mode* is for, not what a default should do. |
| T14a | The two pairs the defaults do not meet are kept as `STRICT_CONTRAST_PAIRS` and the High Contrast theme is measured against them | A dropped check that leaves no trace is indistinguishable from one nobody thought of. This is what stops `CONTRAST_PAIRS` being *lenient* from decaying into `CONTRAST_PAIRS` being *wrong*. The costs are named at the site: placeholders share `text.dimmed` and are not WCAG-exempt, and the scrollbar thumb has no fill to fall back on. |
| T15 | **No border-width token** | Tailwind compiles `.border` to a literal `border-width: 1px` with no variable behind it, unlike `--radius-*` and `--text-*`. The token would appear in the editor, accept a value and change nothing until all 40 components were rewritten. |
| T16 | **Accents are their own tokens** (`accent.*`), at step 700 in light and 400 in dark | `text-primary` resolves to one colour, not a ramp, and `--color-primary: var(--ui-primary)` ships with nothing defining `--ui-primary` — so accents resolved to an undefined custom property in 125 places. Nuxt UI's step 500 is ~2.15:1 for amber on white; 700 clears 4.4 on both the window and a raised panel. Known cost: Tailwind's amber shifts hue as it darkens (84° at 400, 49° at 700), so the light accent reads more rust than gold. |

## Verified mechanism

These were checked against `node_modules`, not assumed. They are what makes "zero component changes"
true rather than asserted.

- **Nuxt UI's entire semantic surface hangs off two ramps.** `--ui-text-*`, `--ui-bg-*` and
  `--ui-border-*` are defined in `.light` / `:root` and `.dark` blocks, every one of them pointing at a
  `--ui-color-neutral-<step>`. Assigning `--ui-color-<role>-<step>` at runtime therefore drives all of
  it.
- **`@theme default inline` is why that works for the colour roles.** The generated
  `.nuxt-ui/ui.css` declares `--color-primary-50: var(--ui-color-primary-50)` under `@theme default
  inline`; `inline` means utilities compile to a direct `var(--ui-color-primary-50)` reference rather
  than to a build-frozen value, leaving `--ui-color-*` live at runtime.
- **`.dark` on the root element is the switch** — Nuxt UI declares
  `@variant dark (&:where(.dark, .dark *))`.
- **Tailwind v4 exposes the shape, type and motion variables** the same way: `--radius-*`
  (`theme.css:397–404`), `--text-*` (`347+`), `--font-sans` / `-serif` / `-mono`, `--spacing`,
  `--default-transition-duration`. `rounded-lg` compiles to `var(--radius-lg)`, so redefining these
  from Fermata tokens themes the existing utility classes with no component edit.
- **Known wrinkle:** `--default-font-family: --theme(--font-sans, initial)` resolves at *build* time.
  The body font must be set explicitly from the token in the bridge rather than relying on overriding
  `--font-sans` alone.

## Architecture

`--fermata-*` is the public token layer and the only thing a theme or an override writes. A bridge
stylesheet assigns Tailwind's and Nuxt UI's variables *from* Fermata tokens. Effective values are
composed in JS — built-in theme, then operator overrides — and written to a single `<style>` element on
`:root`. No component reads `--ui-*`, and no component names a colour.

An override naming a token the current theme does not define is **kept, not dropped** — the unknown-key
rule, which matters here because themes will gain and lose tokens.

## Commit sequence

1. **`src/shared/theme/`, pure and tested, no UI touched.** `tokens.ts` — the catalog (id, group, kind,
   label, help, control hint, per-mode default); this *is* the public API and the T1 naming commitment.
   `themes.ts` — the three built-ins. `ramp.ts` — OKLCH ramp derivation from a seed plus Tailwind
   palette lookup, backing T5a's three modes. `contrast.ts` — WCAG 2.1 relative luminance, the ratio,
   and the token pairs to check. `overrides.ts` — validate and normalise the map, preserving unknown
   names.
2. **The bridge and application.** `theme/bridge.css`, `theme/applyTheme.ts`, a renderer theme store.
   `.dark` lands on the root element; light/dark stops being dead code and the three built-ins become
   real. Reduced-motion clamps duration tokens here, at the token layer, where a theme cannot defeat it.
3. **Main-process ownership.** `nativeTheme.shouldUseDarkColors` and its `updated` event, a new channel
   in `src/shared/ipc.ts`, `win.setBackgroundColor`, and the pre-paint replay in `index.html`.
4. **The `theme` settings category.** `src/shared/settings/theme.ts` with `theme.mode`, `theme.name`
   and `theme.overrides`; the store migration and legacy absorb for `interface.theme` → `theme.mode`.
5. **The token editor**, registered in `customControls.ts` as
   `control: { kind: 'custom', component: 'themeEditor' }`. That register is currently empty by design,
   so this fills W8-6's escape hatch and independently proves its "adding a setting requires zero edits
   to this view" claim.
6. **`tools/eslint/no-raw-colours.mjs`**, wired into the flat config, plus a `tests/tooling/` test that
   lints fixtures through the real config — mirroring `no-windows-path-literals` and
   `pathPortability.test.ts`, so the rule cannot quietly stop being wired up.
7. **Live run** over CDP against a throwaway user-data directory, then the card.

## How "zero component changes" gets checked rather than asserted

Per the card, if this work requires a component edit to function, the token layer is not finished.

- The ESLint rule in step 6 is the standing guard, following the repo's existing precedent.
- The three built-ins in step 1 include one off-palette theme specifically so the swap exercises a hue
  the generated Tailwind ramps cannot produce.
- The live run in step 7 swaps all three themes and authors an override without reloading, since T3's
  live propagation makes preview free — no apply button, no preview mode.

## Progress

| Step | State |
|---|---|
| 1. `src/shared/theme/` — catalog, themes, ramps, contrast, overrides | landed, `9beff38` |
| 2. Bridge and application | landed, `0cdec21` |
| 2a. Mode toggle wiring and the contrast revert | landed, `fe0bf0c` |
| 2b. Coexistence with `UColorModeSwitch` | landed, `ea71c5e` |
| 2c. High Contrast theme | landed, `aa6a16a` |
| 3. `nativeTheme` authoritative in main, window background from the resolved token | not started |
| 4. The `theme` category, `theme.name` / `theme.overrides`, the `interface.theme` migration | partly pre-empted by 2a |
| 5. The token editor | not started |
| 6. `no-raw-colours` lint rule | not started |
| 7. Live run and the card | ongoing — 2a, 2b verified over CDP |

## Known debts this creates

- W8-6's recorded live-run evidence cites `interface.theme`, which T9 renames. That evidence goes stale
  and the card should note it.
- T6 means per-token revert and provenance live in the editor rather than in the W8-5/W8-7 machinery.
  If a second map-valued setting ever appears, that is the moment to reconsider dynamic keys.
- Sharable theme files stay unbuilt. The public/private token split is what would make them cheap
  later, so T1 is the enabling half of a decision D9 has not yet been asked to take.
