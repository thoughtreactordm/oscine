---
title: Oscine Rename — Execution Plan
created: '2026-08-25T16:37:20.689Z'
updated: '2026-08-25T16:37:20.689Z'
---
# Oscine Rename — Execution Plan

**Status: approved, not started.** The app is being renamed **Fermata → Oscine**. Decision made
2026-08-25 after market vetting (Fermata collides with existing mobile/auto-OS players; Oscine
cleared app-collision, domain, and npm checks). `oscine.app` is registered and owned by Michael.
`oscine.io` is taken by a third party — do not reference it anywhere. The npm `oscine` package
name and the `@oscine` org scope were unclaimed as of the decision date; claiming them is an
external chore (see bottom), not part of this plan.

This doc is the complete audit of what the rename touches, produced from a full-repo sweep. A
fresh session can execute from this doc alone. Work tier by tier, in order. Tier 1 items need
decisions/care; Tier 2 is one atomic mechanical sweep; Tier 3 is prose and can trail.

## New identity values

| Thing | Old | New |
|---|---|---|
| `package.json` `name` | `fermata` | `oscine` |
| `package.json` / electron-builder `productName` | `Fermata` | `Oscine` |
| appId (electron-builder.yml + `setAppUserModelId`) | `dev.fermata.app` | `app.oscine.desktop` (reverse-DNS of oscine.app; confirm with Michael if unsure) |
| Custom protocol scheme | `fermata://` | `oscine://` |
| Linux `StartupWMClass` | `Fermata` | `Oscine` (MUST move in lockstep with productName — see T1-3) |
| User-Agent | `Fermata/<ver> ...` | `Oscine/<ver> (local music player)` |

## Tier 1 — identity-bearing state (dire; needs care, not just find-replace)

**T1-1. userData migration (the big one).** `package.json` `name`/`productName` determine
`app.getPath('userData')`. `src/main/index.ts:281` has a deliberate comment declining to call
`app.setName` because everything derives from the package name. The library SQLite DB, settings
registry, artwork cache, scrobble outbox, and stored Last.fm credentials all live in that folder.
Renaming without migration means every existing install (including dev machines) boots with an
empty library. Ship, **in the same commit/release as the rename**, a one-time migration in main —
before anything opens the DB: if the old `fermata` userData dir exists and the new `oscine` one
does not, move/rename it. Cross-platform (old path = userData parent + `fermata` on Linux,
`Fermata` on Windows — verify actual old dir names on both). Add a test.

**T1-2. appId.** Change `appId` in `electron-builder.yml` AND the matching
`app.setAppUserModelId('dev.fermata.app')` at `src/main/index.ts:294` together. Windows treats a
new appId as a brand-new program (no NSIS upgrade-in-place) — acceptable pre-1.0, no action
needed, but say so in the commit message.

**T1-3. productName + StartupWMClass lockstep.** The comment in `electron-builder.yml` documents
why: `StartupWMClass` matches the D-Bus MPRIS client to the window via the Chromium-reported
window class, which IS productName. Changing one without the other breaks the Linux media
widget's name/icon. Change both in the same commit. Afterwards re-run the packaged-Linux MPRIS
acceptance (AppImage build, not dev — `npm run probe:media-session` covers the dev-side check
but the acceptance is on the packaged artifact).

**T1-4. Password-store blob prefix.** `src/main/passwordStore.ts` uses the literal string marker
`FERMATA_PASSWORD_STORE:` on encrypted credential blobs. Changing the on-disk literal orphans
stored Last.fm credentials. Rename the TypeScript identifier freely, but **keep the on-disk
literal as-is** (cheapest), or write new blobs with an `OSCINE_PASSWORD_STORE:` prefix while
accepting both on read. Do NOT blindly find-replace this string.

**T1-5. Renderer localStorage keys.** Keys like `fermata.trackGrouping.v1`,
`fermata.shellLayout.v1` etc. `src/renderer/settings/legacyViewKeys.ts` already exists as the
absorb-old-keys-once mechanism (from W8-3). Add the current `fermata.*` keys to that legacy list
and write new `oscine.*` keys. The machinery exists; follow its existing pattern.

## Tier 2 — wide but mechanical (one atomic commit; typecheck/lint/test catch any miss)

No persistence, no migration; both sides of every contract ship together. Sweep:

- **`fermata://` scheme** — registration in main + artwork/track URLs across renderer, ~60
  occurrences. Internal-only (MPRIS artwork is already re-addressed as blobs, unaffected).
- **IPC channel prefixes** (`fermata:library:` …) — defined once in `src/shared/ipc.ts`,
  imported by main/preload/renderer.
- **`window.fermata` contextBridge global** — preload + `src/renderer/ipc.ts` (~114 hits) +
  tests.
- **Type identifiers** — `FermataError` (~168 occurrences), `isFermataError`, `FermataApi`.
  Pure symbol rename.
- **CSS token namespace** — `--fermata-*` in `src/renderer/theme/bridge.css` (~130) and
  `src/shared/theme/tokens.ts` (~30).
- **ESLint plugin namespace** — `fermata/no-windows-path-literals`, `fermata/no-raw-colours` in
  `eslint.config.mjs` + `tools/eslint/`. `tests/tooling/pathPortability.test.ts` and
  `rawColours.test.ts` verify the wiring and will fail loudly if half-renamed.
- **User-Agent** — `FERMATA_USER_AGENT` in `src/main/net/userAgent.ts`.

After the sweep, run the full pre-push gate: `npm run lint && npm run format:check &&
npm run typecheck && npm test && npm run build`.

## Tier 3 — surface prose (can trail, no behavior)

Log prefixes (`[fermata]`), error-message copy, comments, README, `docs/`, `CLAUDE.md`, test
fixture prefixes (`fermata-test-`), probe scripts, `.kleron` board/wiki text (~300 files), and
eventually the repo folder/remote name. The one same-day item: rename/redirect the
`fermata-design` wiki page so CLAUDE.md's "design authority" pointer doesn't dangle — update
CLAUDE.md's reference in the same change.

Also: `scripts/make-icons.mjs` reproduces the AppTitleBar mark for `build/` icons. The mark
itself (wave-sine glyph) survives the rename — fits Oscine ("oscine" = songbird suborder, and
visually contains "oscillate" — this was part of why the name won. Marketing hook: the songbirds
are the birds that learn their songs). Only regenerate icons if the mark changes.

## Verification checklist

1. Full gate green on the atomic Tier 2 commit.
2. userData migration: populate a library under the old name, build, launch renamed build,
   confirm library/settings/credentials intact.
3. Packaged Linux (AppImage): MPRIS widget shows correct name + artwork.
4. Packaged Windows: installs as Oscine, AppUserModelId correct (media overlay + taskbar).
5. `npm run probe:m2-exit` on both platforms from the renamed commit.

## External chores (Michael, not code)

- Claim npm: create `@oscine` org (free, true reservation) + publish minimal `oscine` package.
- Last.fm API key in `src/main/scrobble/lastfm/appKey.ts` is registered under "Fermata" —
  rename or re-register at last.fm/api.
- GitHub repo rename when ready (old name redirects automatically).
- DNS/site for oscine.app.

Related: [[fermata-design]] (design authority — unaffected by rename except its own name).
